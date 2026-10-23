# create-efc-app

**Interactive scaffolder for Express File Cluster projects.**

[Website](https://efc.prashantadhikari7.com.np/) · [Quick start](https://efc.prashantadhikari7.com.np/docs.html#quickstart) · [Generated portals](https://efc.prashantadhikari7.com.np/docs.html#portals)

## Quick Start

```bash
npx create-efc-app my-api
cd my-api
efc start dev
```

The interactive scaffolder asks for language, database, task queue and clustering, then writes the **base** app: the server, `src/api`, `src/tasks` and the database. It generates a `.env` with a real `JWT_SECRET` and runs `npm install`.

Features (auth incl. Sign in with Google / Apple, user and admin portals, billing, an email client…) can be picked during creation or added later, shadcn-style. Their routes and models are copied into your app as source you own:

```bash
efc list                    # what can be added
efc add auth admin-users    # copies the files, adds packages and env vars
efc add auth@google         # asks for your Google OAuth credentials
efc add email-client        # asks for your SMTP settings
```

See [efc add](https://github.com/pr4shxnt/efc.js/blob/main/docs/cli/add.md).

For full framework documentation on routing, middleware, clustering, and tasks, please see the [Express File Cluster](https://www.npmjs.com/package/express-file-cluster) package or the [GitHub Repository](https://github.com/pr4shxnt/efc.js).
