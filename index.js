// cloudflare database

const CORS = {
  'Access-Control-Allow-Origin': 'https://sb-vault.github.io',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

async function getSession(request, env) {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const session = await env.SESSIONS.get(`session:${token}`);
  if (!session) return null;
  return JSON.parse(session);
}

function generateId() {
  return crypto.randomUUID().replace(/-/g, '');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // ── Bazaar proxy ───────────────────────────────────────────────────────
    if (url.pathname === '/bazaar') {
      const resp = await fetch('https://api.hypixel.net/skyblock/bazaar');
      const data = await resp.json();
      return json(data);
    }

    // ── Auth: exchange MC-ID code for session ──────────────────────────────
    if (url.pathname === '/auth/token' && request.method === 'POST') {
      const body = await request.json();
      const { code, code_verifier } = body;
      if (!code || !code_verifier) return err('Missing code or code_verifier');

      const tokenRes = await fetch('https://mc-id.com/api/auth/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: env.MCID_CLIENT_ID,
          client_secret: env.MCID_CLIENT_SECRET,
          redirect_uri: env.MCID_REDIRECT_URI,
          code_verifier,
        }),
      });

      const tokens = await tokenRes.json();
      if (!tokens.access_token) return err('Token exchange failed');

      const profileRes = await fetch('https://mc-id.com/api/auth/oauth2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const profile = await profileRes.json();

      const account = profile.accounts?.find(a => a.primary) || profile.accounts?.[0];
      const discord = profile.connections?.find(c => c.providerId === 'discord');

      if (!account?.uuid) return err('No Minecraft account linked on MC-ID');

      const now = Date.now();

      await env.DB.prepare(`
        INSERT INTO users (uuid, sub, username, discord, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(uuid) DO UPDATE SET
          username = excluded.username,
          discord = excluded.discord,
          updated_at = excluded.updated_at
      `).bind(
        account.uuid,
        profile.sub,
        account.username,
        discord?.accountId || null,
        now,
        now,
      ).run();

      const sessionToken = generateId() + generateId();
      await env.SESSIONS.put(
        `session:${sessionToken}`,
        JSON.stringify({
          uuid: account.uuid,
          username: account.username,
          discord: discord?.accountId || null,
          sub: profile.sub,
        }),
        { expirationTtl: 60 * 60 * 24 * 30 },
      );

      return json({
        token: sessionToken,
        user: {
          uuid: account.uuid,
          username: account.username,
          discord: discord?.accountId || null,
        },
      });
    }

    // ── Auth: get current user ─────────────────────────────────────────────
    if (url.pathname === '/auth/me' && request.method === 'GET') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);
      return json({ user: session });
    }

    // ── Auth: logout ───────────────────────────────────────────────────────
    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      const token = request.headers.get('Authorization')?.replace('Bearer ', '');
      if (token) await env.SESSIONS.delete(`session:${token}`);
      return json({ ok: true });
    }

    // ── Listings: get all ──────────────────────────────────────────────────
    if (url.pathname === '/listings' && request.method === 'GET') {
      const cat = url.searchParams.get('cat');
      const q = url.searchParams.get('q');
      const sort = url.searchParams.get('sort') || 'newest';
      const status = url.searchParams.get('status') || 'active';

      let query = `SELECT * FROM listings WHERE status = ?`;
      const params = [status];

      if (cat && cat !== 'all') {
        query += ` AND cat = ?`;
        params.push(cat);
      }

      if (q) {
        query += ` AND (armour_type LIKE ? OR set_name LIKE ? OR ign LIKE ?)`;
        const like = `%${q}%`;
        params.push(like, like, like);
      }

      const orderMap = {
        newest: 'ts DESC',
        oldest: 'ts ASC',
        'price-asc': 'price ASC',
        'price-desc': 'price DESC',
      };
      query += ` ORDER BY ${orderMap[sort] || 'ts DESC'} LIMIT 200`;

      const { results } = await env.DB.prepare(query).bind(...params).all();
      return json({
        listings: results.map(r => ({ ...r, pieces: JSON.parse(r.pieces) })),
      });
    }

    // ── Listings: stats ────────────────────────────────────────────────────────────────────
    if (url.pathname === '/listings/stats' && request.method === 'GET') {
        const [active, users, sold] = await Promise.all([
            env.DB.prepare(`SELECT COUNT(*) as n FROM listings WHERE status = 'active'`).first(),
            env.DB.prepare(`SELECT COUNT(*) as n FROM users`).first(),
            env.DB.prepare(`SELECT COUNT(*) as n FROM listings WHERE status = 'sold'`).first(),
        ]);
        return json({ active: active.n, users: users.n, sold: sold.n });
    }

    // ── Listings: create ───────────────────────────────────────────────────
    if (url.pathname === '/listings' && request.method === 'POST') {
    const body = await request.json();
    const { armourType, setName, pieces, cat, catLabel, price, proof, notes, ign: bodyIgn } = body;

    if (!armourType || !pieces?.length || !price || price <= 0) {
        return err('Missing required fields');
    }

    // Auth is optional — verified session gets UUID attached, unverified uses body IGN
    const session = await getSession(request, env);
    const finalIgn = session?.username || bodyIgn;
    const finalUuid = session?.uuid || null;

    if (!finalIgn) return err('IGN required');

    const id = generateId();
    const now = Date.now();

    await env.DB.prepare(`
        INSERT INTO listings
        (id, uuid, ign, armour_type, set_name, pieces, cat, cat_label, price, proof, notes, status, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `).bind(
        id,
        finalUuid,
        finalIgn,
        armourType,
        setName || '',
        JSON.stringify(pieces),
        cat || 'exotic',
        catLabel || 'Exotic',
        price,
        proof || '',
        notes || '',
        now,
    ).run();

    return json({ id, ok: true }, 201);
    }

    // ── Listings: mark sold ────────────────────────────────────────────────
    if (url.pathname.match(/^\/listings\/[a-f0-9]+\/sold$/) && request.method === 'PUT') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);

      const id = url.pathname.split('/')[2];
      const listing = await env.DB.prepare(
        `SELECT uuid FROM listings WHERE id = ?`
      ).bind(id).first();

      if (!listing) return err('Not found', 404);
      if (listing.uuid !== session.uuid) return err('Forbidden', 403);

      await env.DB.prepare(
        `UPDATE listings SET status = 'sold', sold_at = ? WHERE id = ?`
      ).bind(Date.now(), id).run();

      return json({ ok: true });
    }

    // ── Listings: delete ───────────────────────────────────────────────────
    if (url.pathname.match(/^\/listings\/[a-f0-9]+\/delete$/) && request.method === 'PUT') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);

      const id = url.pathname.split('/')[2];
      const listing = await env.DB.prepare(
        `SELECT uuid FROM listings WHERE id = ?`
      ).bind(id).first();

      if (!listing) return err('Not found', 404);
      if (listing.uuid !== session.uuid) return err('Forbidden', 403);

      await env.DB.prepare(
        `UPDATE listings SET status = 'deleted' WHERE id = ?`
      ).bind(id).run();

      return json({ ok: true });
    }

    // ── Offers: create ─────────────────────────────────────────────────────
    if (url.pathname === '/offers' && request.method === 'POST') {
      const body = await request.json();
      const { listingId, buyerIgn, amount, message } = body;

      if (!listingId || !buyerIgn || !amount) return err('Missing required fields');

      const listing = await env.DB.prepare(
        `SELECT id FROM listings WHERE id = ? AND status = 'active'`
      ).bind(listingId).first();
      if (!listing) return err('Listing not found', 404);

      const session = await getSession(request, env);
      const id = generateId();

      await env.DB.prepare(`
        INSERT INTO offers (id, listing_id, buyer_uuid, buyer_ign, amount, message, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        listingId,
        session?.uuid || null,
        buyerIgn,
        amount,
        message || '',
        Date.now(),
      ).run();

      return json({ id, ok: true }, 201);
    }

    // ── Offers: get for listing (owner only) ───────────────────────────────
    if (url.pathname.match(/^\/offers\/[a-f0-9]+$/) && request.method === 'GET') {
      const session = await getSession(request, env);
      if (!session) return err('Unauthorised', 401);

      const listingId = url.pathname.split('/')[2];
      const listing = await env.DB.prepare(
        `SELECT uuid FROM listings WHERE id = ?`
      ).bind(listingId).first();

      if (!listing) return err('Not found', 404);
      if (listing.uuid !== session.uuid) return err('Forbidden', 403);

      const { results } = await env.DB.prepare(
        `SELECT * FROM offers WHERE listing_id = ? ORDER BY ts DESC`
      ).bind(listingId).all();

      return json({ offers: results });
    }

    return err('Not found', 404);
  },
};