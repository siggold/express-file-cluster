# Sign in with Google & Apple

Two registry items add OAuth sign-in next to email/password [auth](./authentication.md):

```bash
efc add auth@google      # asks for the Google client ID and secret
efc add auth@apple       # asks for the Services ID, Team ID, Key ID and .p8 key
```

Both install `auth` first if it's missing. Like every [registry item](../cli/add.md), the code is copied into your app and is yours to change. Nothing about it is hidden in a package.

---

## What gets added

| File | Purpose |
|---|---|
| `src/api/auth/google/index.ts` | `GET /auth/google`: redirects to Google's consent screen |
| `src/api/auth/google/callback.ts` | `GET /auth/google/callback`: Google redirects here, the user is signed in |
| `src/api/auth/apple/index.ts` | `GET /auth/apple`: redirects to Apple |
| `src/api/auth/apple/callback.ts` | `POST /auth/apple/callback`: Apple posts here (`form_post`), the user is signed in |
| `src/lib/oauth.ts` | Shared: the state cookie, find-or-create the user, issue the token |
| `src/model/OAuthAccount.ts` | Links a provider identity (`google:<sub>`) to a `User` |

Plus the `jose` package, which verifies the providers' ID tokens and signs Apple's client secret, and these env vars:

| Variable | |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From your OAuth client in the Google Cloud console |
| `GOOGLE_REDIRECT_URI` | The callback URL, e.g. `http://localhost:3000/v1/api/auth/google/callback`. Register exactly this URL on the client |
| `APPLE_CLIENT_ID` | Your Services ID, e.g. `com.yourapp.signin` |
| `APPLE_TEAM_ID`, `APPLE_KEY_ID` | Your team ID and the ID of your Sign in with Apple key |
| `APPLE_PRIVATE_KEY` | The `.p8` key's contents, newlines written as `\n`. `efc add` reads the file for you |
| `APPLE_REDIRECT_URI` | The callback URL. It must be https, on a domain verified with Apple, and registered on the Services ID. Apple rejects `localhost` |
| `OAUTH_SUCCESS_REDIRECT` | Where the browser goes after signing in (your frontend) |

---

## Setting up the providers

**Google.** In [console.cloud.google.com](https://console.cloud.google.com), go to *APIs & Services → Credentials → Create credentials → OAuth client ID*. Choose application type *Web application* and add `GOOGLE_REDIRECT_URI` under *Authorised redirect URIs*. Configure the consent screen if asked; the `openid`, `email` and `profile` scopes are enough.

**Apple.** In [developer.apple.com](https://developer.apple.com) → *Certificates, IDs & Profiles*:

1. An **App ID** with *Sign in with Apple* enabled.
2. A **Services ID** (this is `APPLE_CLIENT_ID`) with *Sign in with Apple* enabled, your domain, and `APPLE_REDIRECT_URI` as a return URL.
3. A **Key** with *Sign in with Apple*. Download the `.p8` file (you can only do this once) and note its Key ID.

To try Apple sign-in locally, expose your dev server over https with a tunnel and register that URL.

---

## Using it from a frontend

Send the browser (not `fetch`) to the start route:

```html
<a href="https://api.yourapp.com/v1/api/auth/google">Continue with Google</a>
<a href="https://api.yourapp.com/v1/api/auth/apple">Continue with Apple</a>
```

After the provider sends the user back, the callback sets the usual `efc_token` cookie (the same one `/auth/login` sets) and redirects to `OAUTH_SUCCESS_REDIRECT`. From there, requests with credentials work as after a password login, and `GET /auth/me` returns the user.

> The callbacks issue the session as an http-only cookie, so they fit `authStrategy: 'http-only'`. With the `localStorage` (Bearer) strategy, change the callback to hand the token to your SPA, for example with `signToken()` and a redirect to your frontend that carries it.

---

## How sign-in works

1. **Start.** The start route stores a random `state` and `nonce` (and, for Google, a PKCE verifier) in a short-lived http-only cookie, then redirects to the provider.
2. **Callback.** The callback checks `state` against the cookie and clears it. It trades the code for tokens at the provider (Google: with the PKCE verifier; Apple: with a client secret, an ES256 JWT signed with your key) and verifies the ID token's signature, issuer, audience and `nonce` against the provider's published keys.
3. **Find or create the user** (`signInWithOAuth` in `src/lib/oauth.ts`):
   - the `User` already linked to this identity in `OAuthAccount`; otherwise
   - the `User` with the same email, **if the provider says the email is verified**, which then gets linked; otherwise
   - a new `User` (`isVerified: true`, a random password; they can set a real one with [forgot-password](./generated-portals.md)).

   An unknown identity without a verified email is refused (400). A suspended user (`isActive: false`) gets 403.
4. **Sign in.** `issueToken()` sets the cookie and the browser goes to `OAUTH_SUCCESS_REDIRECT`.

Apple only sends the user's name on their **first** sign-in. The callback uses it when it creates the user.

Apple posts its callback from its own site, so the start route marks the Apple state cookie `SameSite=None; Secure`. Browsers accept that on https and on `localhost`.

---

## Errors

| Status | When |
|---|---|
| 400 | The provider returned an error, the state is missing, expired (10 minutes) or doesn't match, the `nonce` doesn't match, or there's no verified email for a new identity |
| 403 | The user is suspended |
| 502 | The provider rejected the code exchange (wrong client secret / key, code already used, redirect URI mismatch) |

The callbacks answer with JSON errors. To send users back to your frontend instead, catch the error in the callback and redirect, e.g. to `${OAUTH_SUCCESS_REDIRECT}?error=…`.
