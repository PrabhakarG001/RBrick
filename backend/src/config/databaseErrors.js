// Classify driver errors without returning any raw message, URI or credentials.
export function databaseFailure(error) {
  const errors = [error, error?.cause, ...Array.from(error?.reason?.servers?.values?.() || [], server => server.error)];
  const codes = errors.flatMap(item => [item?.code, item?.cause?.code]);
  const messages = errors.map(item => item?.message || '').join(' ');
  if (codes.includes(18) || /bad auth|authentication failed|auth failed/i.test(messages)) {
    return { code: 'authentication_failed', message: 'Atlas rejected database-user authentication. Verify/reset the password in Atlas Database Access, update the private root .env, and recreate the backend.' };
  }
  if (codes.includes(13)) return { code: 'permission_denied', message: 'Atlas database user lacks the required permissions. Check readWrite access for DB_NAME.' };
  if (codes.includes('ATLAS_NOT_CONFIGURED')) return { code: 'not_configured', message: 'Set MONGODB_URI in the private root .env.' };
  if (errors.some(item => item?.name === 'MongoParseError') || /Invalid database URI scheme/.test(messages)) {
    return { code: 'invalid_uri', message: 'Invalid MongoDB URI. Use the Atlas Drivers URI and percent-encode credentials.' };
  }
  if (codes.some(code => typeof code === 'string' && /TLS|SSL|CERT/.test(code))) {
    return { code: 'tls_failed', message: 'Atlas TLS handshake failed. Check IP access, firewall/VPN interception and CA trust; keep certificate validation enabled.' };
  }
  if (codes.some(code => ['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ESERVFAIL'].includes(code))) {
    return { code: 'dns_failed', message: 'Atlas DNS lookup failed. Check the cluster hostname and DNS/network configuration.' };
  }
  if (errors.some(item => item?.name === 'MongooseServerSelectionError' || item?.name === 'MongoNetworkError')) {
    return { code: 'network_unavailable', message: 'Atlas is unreachable. Check cluster availability, current public IP access and outbound network connectivity.' };
  }
  return { code: 'database_operation_failed', message: 'Atlas connection/index operation failed. Check connectivity, database permissions and existing indexes. Raw details omitted.' };
}
