# Security policy

- Never commit `.env`, API keys, production requirements, customer data, traces, or screenshots containing sensitive information.
- Store `OPENAI_API_KEY` in the local environment or GitHub Actions encrypted secrets.
- Treat agent output as untrusted until schema validation and human review complete.
- Do not let generated test steps execute destructive actions against production systems.
- Use synthetic examples in issues, pull requests, artifacts, and evaluation datasets.

Report a suspected vulnerability privately through GitHub's security advisory workflow rather than a public issue.
