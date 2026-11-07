// Demo signing keys for the AP2 roles (ES256). Kept in the database so that
// mandates signed earlier still verify after a restart. In production the user
// key lives on the Trusted Surface (device or wallet), not on this server.
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import type { DB } from '../db.ts';
import { nowIso } from '../db.ts';

export async function roleKey(db: DB, kid: string): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  const row = db.prepare('SELECT private_jwk FROM ap2_keys WHERE kid = ?').get(kid) as { private_jwk: string } | undefined;
  let priv: JWK;
  if (row) priv = JSON.parse(row.private_jwk);
  else {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    priv = { ...(await exportJWK(privateKey)), kid, alg: 'ES256' };
    db.prepare('INSERT OR IGNORE INTO ap2_keys (kid, private_jwk, created_at) VALUES (?, ?, ?)').run(kid, JSON.stringify(priv), nowIso());
    priv = JSON.parse((db.prepare('SELECT private_jwk FROM ap2_keys WHERE kid = ?').get(kid) as { private_jwk: string }).private_jwk);
  }
  const { d: _d, ...pub } = priv;
  return { privateJwk: priv, publicJwk: pub };
}
