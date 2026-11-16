# Legwork API

Visa application backend (Express 5, TypeScript, PostgreSQL, Redis + BullMQ).

## Local setup

Prerequisites: Node.js (same major version as the team), Docker Desktop, PostgreSQL.

1. Clone the repo and switch to development:

   ```bash
   git clone <repo-url>
   cd legwork-api
   git checkout development
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create a file named `.env` in the project root. Do not commit it. Set:

   ```dotenv
   NODE_ENV=development
   PORT=4000
   DATABASE_URL=postgresql://<user>:<password>@localhost:5432/legwork
   WEB_URL=http://localhost:3000
   PAYMENT_PROVIDER=dummy
   FIELD_ENCRYPTION_KEY=<64-character hex string, generate your own>
   ADMIN_PASSWORD=<at least 8 characters>
   ```

4. Start Redis (needed for document scanning):

   ```bash
   docker compose up -d redis
   ```

5. Create the database schema and seed test data:

   ```bash
   npm run db:migrate
   npm run db:seed
   ```

6. Start the API in one terminal:

   ```bash
   npm run dev
   ```

7. Start the document scan worker in a second terminal:

   ```bash
   npm run worker
   ```

8. Check the API is running:

   ```
   http://localhost:4000/health
   ```

## Notes

- Each developer uses their own local database and their own `FIELD_ENCRYPTION_KEY`. Passport data encrypted with one key cannot be read with another.
- Without Redis and the worker, document uploads return 503 and the document stays `pending_scan`. This is expected.
- Never commit `.env`, and never share passwords or connection strings in chat or in the repo.
- API contract: `docs/api-contract.md`.
