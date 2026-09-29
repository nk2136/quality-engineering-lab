import { createServer, type Server } from 'node:http';

const page = `<!doctype html>
<html lang="en">
  <body>
    <main>
      <h1>Eligibility check</h1>
      <form aria-label="Eligibility check">
        <label for="member-id">Member ID</label>
        <input id="member-id" name="memberId" required>
        <button type="submit" data-testid="eligibility-submit">Check eligibility</button>
      </form>
      <p role="status" hidden>Eligible</p>
      <p role="alert" hidden>Member ID is required</p>
      <section aria-label="No prior checks">No prior checks</section>
      <table aria-label="Benefits"><tbody><tr><th>Plan</th><td>Standard</td></tr></tbody></table>
      <ul aria-label="Checks"><li>Identity verified</li></ul>
      <benefit-card></benefit-card>
      <secure-card data-shadow-root="closed"></secure-card>
      <iframe title="Details" srcdoc="<p>Member details</p>"></iframe>
      <button type="button" data-action="delete-history">Delete history</button>
    </main>
  </body>
</html>`;

export function createDemoServer(): Server {
  return createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: 'https://example.invalid' }).end();
      return;
    }
    if (request.url !== '/eligibility') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`${page}<script>
      const form = document.querySelector('form');
      const input = document.querySelector('#member-id');
      const status = document.querySelector('[role=status]');
      const alert = document.querySelector('[role=alert]');
      document.querySelector('benefit-card').attachShadow({ mode: 'open' }).innerHTML = '<button>View benefit</button>';
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const valid = input.value.trim() !== '';
        alert.hidden = valid;
        status.hidden = !valid;
      });
    </script>`);
  });
}

if (process.argv[1]?.endsWith('demo-app.ts')) {
  const server = createDemoServer();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') console.log(`http://127.0.0.1:${address.port}/eligibility`);
  });
}
