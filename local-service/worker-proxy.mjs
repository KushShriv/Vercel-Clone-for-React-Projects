import http from 'node:http';
import net from 'node:net';

// The build container has access only to this proxy on an internal network.
// Never forward ordinary HTTP, arbitrary destinations, or arbitrary ports.
const allowed = new Set(['github.com:443', 'registry.npmjs.org:443']);
const server = http.createServer((_request, response) => { response.writeHead(403); response.end(); });
server.on('connect', (request, client, head) => {
  if (!allowed.has(request.url?.toLowerCase())) { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  const host = request.url.slice(0, -4).toLowerCase();
  const upstream = net.connect({ host, port: 443 });
  const close = () => { client.destroy(); upstream.destroy(); };
  client.setTimeout(120000, close);
  upstream.setTimeout(120000, close);
  client.on('error', close); upstream.on('error', close);
  upstream.once('connect', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    client.pipe(upstream); upstream.pipe(client);
  });
});
server.headersTimeout = 10000;
server.listen(3128, '0.0.0.0');
