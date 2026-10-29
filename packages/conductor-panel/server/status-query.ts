/** Shared strict query shape; issuer authorization stays with the selected store. */
export function operationStatusQuery(body: Record<string, unknown>): {issuer:string;jti:string} | null {
  if (Object.keys(body).length !== 2 || !Object.hasOwn(body,'issuer') || !Object.hasOwn(body,'jti') || typeof body.issuer !== 'string' || typeof body.jti !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.jti) || Buffer.from(body.jti,'base64url').toString('base64url') !== body.jti) return null;
  return {issuer:body.issuer,jti:body.jti};
}
