# Generated Portals — User & Admin

The user and admin portals are a set of **registry items**: ready-made models and routes you pick in `create-efc-app` or add later with [`efc add`](../cli/add.md), anything from auth extras (2FA, sessions, password reset) to admin content management (blogs, FAQs, coupons). This page lists every route each item adds, so nothing you didn't ask for shows up as a surprise, and nothing you did add goes undocumented.

> Every model below is real on both databases. On MongoDB they're `defineModel` collections. On PostgreSQL they're [`defineTable`](../api-reference/table.md) models (or `defineModel`, if you picked it) linked by foreign keys. `Session`, `Notification`, `File`, `SupportTicket`, `Subscription`, `Invoice` and `ApiKey` reference `User` and are deleted with it. `Subscription` references `Plan`, and `Invoice` references its `Subscription`. `AuditLog`, `Blog` and assigned tickets reference an `Admin`, which is cleared when the admin is deleted. `Category` references its parent. Models carry no back-relations, so each feature stays self-contained. Add `relations` to a model when you want `include` (e.g. `user.sessions`). See [Database](./database.md).

---

## auth

`efc add auth` (every other item depends on it):

- `src/model/User.ts`, `src/model/Admin.ts`
- `POST /auth/register`, `POST /auth/login` (users and admins), `POST /auth/logout`, `GET /auth/me`

`efc add auth@google` / `auth@apple` add OAuth sign-in for users (`GET /auth/google` + `/auth/google/callback`, `GET /auth/apple` + `POST /auth/apple/callback`, `OAuthAccount` model). See [Sign in with Google & Apple](./oauth.md).

---

## User portal

| Item | Routes below |
|---|---|
| `user-profile` | Profile: `/user/profile` |
| `forgot-password` | Auth: forgot / reset password |
| `account-security` | Auth: refresh, change password, 2FA, sessions (+ `Session`) |
| `email-verification` | Auth: verify email |
| `account-settings` | Profile: avatar, settings, account, dashboard, activity |
| `notifications` | Notifications (+ `Notification`) |
| `files` | Files, favorites / bookmarks, search (+ `File`) |
| `billing` | API keys, billing (+ `Plan`, `Subscription`, `Invoice`, `ApiKey`) |
| `support` | Support (+ `SupportTicket`) |

### Routes

| Area | Method & Path |
|---|---|
| Auth | `POST /auth/register` |
| | `GET /auth/me` |
| | `POST /auth/refresh` |
| | `GET /auth/verify-email`, `POST /auth/verify-email` |
| | `POST /auth/forgot-password` |
| | `POST /auth/reset-password` |
| | `POST /auth/change-password` |
| | `GET /auth/2fa/setup`, `POST /auth/2fa/setup` |
| | `POST /auth/2fa/verify` |
| | `POST /auth/2fa/disable` |
| | `GET /auth/sessions`, `DELETE /auth/sessions/:id` |
| Profile | `GET /user/profile`, `PUT /user/profile` |
| | `POST /user/avatar`, `DELETE /user/avatar` |
| | `GET /user/settings`, `PUT /user/settings` |
| | `GET /user/account`, `DELETE /user/account` |
| | `GET /user/dashboard` |
| | `GET /user/activity` |
| Notifications | `GET /user/notifications`, `POST /user/notifications` (mark all read) |
| | `GET /user/notifications/:id`, `PATCH /user/notifications/:id`, `DELETE /user/notifications/:id` |
| Files | `GET /user/files`, `POST /user/files` |
| | `GET /user/files/:id`, `DELETE /user/files/:id` |
| Favorites / bookmarks | `GET /user/favorites`, `POST /user/favorites`, `DELETE /user/favorites/:id` |
| | `GET /user/bookmarks`, `POST /user/bookmarks`, `DELETE /user/bookmarks/:id` |
| Search | `GET /user/search` |
| API keys | `GET /user/api-keys`, `POST /user/api-keys`, `DELETE /user/api-keys/:id` |
| Billing | `GET /user/billing/plans` |
| | `GET /user/billing/subscription`, `POST /user/billing/subscription`, `DELETE /user/billing/subscription` |
| | `GET /user/billing/payment-methods`, `POST /user/billing/payment-methods`, `DELETE /user/billing/payment-methods/:id` |
| | `GET /user/billing/invoices`, `GET /user/billing/invoices/:id` |
| Support | `GET /support/tickets`, `POST /support/tickets` |
| | `GET /support/tickets/:id`, `PUT /support/tickets/:id` |

Protected routes export `middlewares = [requireAuth('user', 'admin')]` (see [RBAC](./rbac.md)).

---

## Admin portal

| Item | Routes below |
|---|---|
| `admin` | Dashboard |
| `admin-users` | Users |
| `admin-admins` | Admins, Roles (+ `Role`) |
| `admin-analytics` | Analytics |
| `admin-content` | Content (+ `FAQ`, `Blog`, `Category`) |
| `admin-billing` | Billing (+ `Plan`, `Coupon`) |
| `admin-support` | Support (+ `SupportTicket`) |
| `admin-logs` | Notifications, Logs (+ `AuditLog`, `Notification`) |
| `admin-system` | Settings, System |

`Plan`, `SupportTicket` and `Notification` are shared with the user-portal items: both write the same file, and the second add skips it.

### Routes

| Area | Method & Path |
|---|---|
| Dashboard | `GET /admin/dashboard` |
| Users | `GET /admin/users`, `POST /admin/users` |
| | `GET /admin/users/:id`, `PUT /admin/users/:id`, `DELETE /admin/users/:id` |
| | `POST /admin/users/:id/suspend`, `POST /admin/users/:id/activate`, `POST /admin/users/:id/verify` |
| | `GET /admin/users/export` (CSV) |
| Analytics | `GET /admin/analytics`, `/users`, `/revenue`, `/traffic` |
| Admins | `GET /admin/admins`, `POST /admin/admins` |
| | `GET /admin/admins/:id`, `PUT /admin/admins/:id`, `DELETE /admin/admins/:id` |
| Notifications | `GET /admin/notifications`, `POST /admin/notifications` |
| | `POST /admin/notifications/broadcast` |
| Logs | `GET /admin/logs/audit`, `/activity`, `/security` |
| Settings | `GET /admin/settings`, `PUT /admin/settings` |
| System | `GET /admin/system/health` |
| | `DELETE /admin/system/cache` |
| Support | `GET /admin/tickets`, `GET /admin/tickets/:id`, `PUT /admin/tickets/:id` |
| Content — FAQs | `GET /admin/content/faqs`, `POST /admin/content/faqs` |
| | `GET/PUT/DELETE /admin/content/faqs/:id` |
| Content — Blog | `GET /admin/content/blogs`, `POST /admin/content/blogs` |
| | `GET/PUT/DELETE /admin/content/blogs/:id` |
| Content — Categories | `GET /admin/content/categories`, `POST /admin/content/categories` |
| | `GET/PUT/DELETE /admin/content/categories/:id` |
| Billing — Plans | `GET /admin/billing/plans`, `POST /admin/billing/plans` |
| | `GET/PUT/DELETE /admin/billing/plans/:id` |
| Billing — Coupons | `GET /admin/billing/coupons`, `POST /admin/billing/coupons` |
| | `GET/PUT/DELETE /admin/billing/coupons/:id` |
| Billing — Subscriptions | `GET /admin/billing/subscriptions` |
| Roles | `GET /admin/roles`, `POST /admin/roles` |
| | `GET/PUT/DELETE /admin/roles/:id` |

All admin routes export `middlewares = [requireAuth('admin')]` (see [RBAC](./rbac.md)).

---

## Related

- [RBAC](./rbac.md) — how the `requireAuth('role')` shorthand and the `Role` model plug into these routes
- [Mailer](./mailer.md) — hook up real email for verification/reset flows
- [Database](./database.md) — MongoDB vs PostgreSQL implementation status
- [Project Structure](../getting-started/project-structure.md) — where these files land on disk
