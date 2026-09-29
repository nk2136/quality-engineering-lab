import { createServer, type Server } from 'node:http';

const page = `<!doctype html>
<html lang="en">
  <body>
    <main>
      <h1>Eligibility check</h1>
      <form aria-label="Eligibility check">
        <label for="member-id">Member ID</label>
        <input id="member-id" name="memberId" required>
        <button type="submit">Check eligibility</button>
      </form>
      <p role="status" hidden>Eligible</p>
      <p role="alert" hidden>Member ID is required</p>
      <section aria-label="No prior checks">No prior checks</section>
      <button type="button" data-action="delete-history">Delete history</button>
    </main>
  </body>
</html>`;

export function createDemoServer(): Server {
  return createServer((request, response) => {
    if (request.url !== '/eligibility') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
  });
}

if (process.argv[1]?.endsWith('demo-app.ts')) {
  const server = createDemoServer();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') console.log(`http://127.0.0.1:${address.port}/eligibility`);
  });
}
