# Render deployment

Use a Render Web Service (not Static Site).

Build command: `npm install`
Start command: `npm start`
Health check: `/health`

The repository intentionally uses `npm install` instead of `npm ci` because this project does not require a committed npm lockfile. Render's `npm ci` requires a lockfile that matches package.json.
