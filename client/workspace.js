/* ─── FILE CONTENTS — verbatim from /usage, the real EFC example app ─── */
const FILES = {
  "src/api/admin/admins/[id].ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'Fetch a single admin account by ID (admin only).',\n      request: { params: { id: 'adm_01HXZ' } },\n      response: { status: 200, body: { admin: { id: 'adm_01HXZ' } } },\n  },\n  PUT: {\n    description: 'Update an admin account by ID (admin only).',\n      request: { params: { id: 'adm_01HXZ' }, body: { name: 'Jane Doe', role: 'admin' } },\n      response: { status: 200, body: { message: 'Admin updated', admin: { id: 'adm_01HXZ', name: 'Jane Doe', role: 'admin' } } },\n  },\n  DELETE: {\n    description: 'Delete an admin account by ID (admin only).',\n      request: { params: { id: 'adm_01HXZ' } },\n      response: { status: 200, body: { message: 'Admin adm_01HXZ deleted' } },\n  },\n};\n\nexport const middlewares = [requireAuth('admin')];\n\nexport const GET = async (req: Request, res: Response) => {\n  const { id } = req.params;\n  // TODO: fetch admin by id\n  res.json({ admin: { id } });\n};\n\nexport const PUT = async (req: Request, res: Response) => {\n  const { id } = req.params;\n  // TODO: update admin record\n  res.json({ message: 'Admin updated', admin: { id, ...req.body } });\n};\n\nexport const DELETE = async (req: Request, res: Response) => {\n  const { id } = req.params;\n  // TODO: delete admin\n  res.json({ message: `Admin ${id} deleted` });\n};\n",
  "src/api/admin/admins/index.ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport bcrypt from 'bcrypt';\nimport { Admin } from '../../../model/Admin.js';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'List all admin accounts (admin only).',\n      response: { status: 200, body: { admins: [], total: 0 } },\n  },\n  POST: {\n    description: 'Create a new admin account (admin only). adminNumber and createdBy are filled in automatically by the schema.',\n      request: { body: { name: 'Jane Doe', email: 'jane@example.com', password: 'secret', role: 'admin' } },\n      response: { status: 201, body: { message: 'Admin created', admin: { id: 'new-id', adminNumber: 4, name: 'Jane Doe', email: 'jane@example.com', role: 'admin', createdBy: 'adm_01HXZ' } } },\n  },\n};\n\nexport const middlewares = [requireAuth('admin')];\n\nexport const GET = async (_req: Request, res: Response) => {\n  const [admins, total] = await Promise.all([Admin.find({}), Admin.count({})]);\n  res.json({ admins: admins.map(({ password: _, ...a }) => a), total });\n};\n\nexport const POST = async (req: Request, res: Response) => {\n  const { name, email, password, role } = req.body;\n  if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });\n  const existing = await Admin.findOne({ email });\n  if (existing) return res.status(409).json({ error: 'Email already in use' });\n  const hashed = await bcrypt.hash(password, 10);\n  // adminNumber (sequence) and createdBy ($currentUser.id — this request's own JWT,\n  // verified by requireAuth above) are populated by the schema, not this handler.\n  const admin = await Admin.create({ name, email, password: hashed, role: role ?? 'admin' });\n  const { password: _, ...safe } = admin;\n  res.status(201).json({ message: 'Admin created', admin: safe });\n};\n",
  "src/api/admin/dashboard.ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport { User } from '../../model/User.js';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'Admin dashboard stats. Requires admin role.',\n    response: { status: 200, body: { stats: { totalUsers: 120, activeUsers: 98, verifiedUsers: 84 } } },\n  },\n};\n\nexport const middlewares = [requireAuth('admin')];\n\nexport const GET = async (_req: Request, res: Response) => {\n  const [totalUsers, activeUsers, verifiedUsers] = await Promise.all([\n    User.count({}),\n    User.count({ isActive: true }),\n    User.count({ isVerified: true }),\n  ]);\n  res.json({ stats: { totalUsers, activeUsers, verifiedUsers } });\n};\n",
  "src/api/admin/roles/[id].ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'Fetch a single role by ID (admin only).',\n      request: { params: { id: 'role_01HXZ' } },\n      response: { status: 200, body: { role: { id: 'role_01HXZ', name: 'editor', permissions: ['content:write'] } } },\n  },\n  PUT: {\n    description: 'Update a role by ID (admin only).',\n      request: { params: { id: 'role_01HXZ' }, body: { name: 'editor', permissions: ['content:write'] } },\n      response: { status: 200, body: { message: 'Role updated', role: { id: 'role_01HXZ', name: 'editor', permissions: ['content:write'] } } },\n  },\n  DELETE: {\n    description: 'Delete a role by ID (admin only).',\n      request: { params: { id: 'role_01HXZ' } },\n      response: { status: 200, body: { message: 'Role role_01HXZ deleted' } },\n  },\n};\n\nexport const middlewares = [requireAuth('admin')];\n\nexport const GET = async (req: Request, res: Response) => {\n  const { id } = req.params;\n  // TODO: fetch role by id\n  res.json({ role: { id } });\n};\n\nexport const PUT = async (req: Request, res: Response) => {\n  const { id } = req.params;\n  // TODO: update role\n  res.json({ message: 'Role updated', role: { id, ...req.body } });\n};\n\nexport const DELETE = async (req: Request, res: Response) => {\n  const { id } = req.params;\n  // TODO: delete role\n  res.json({ message: `Role ${id} deleted` });\n};\n",
  "src/api/admin/roles/index.ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'List all roles (admin only).',\n      response: { status: 200, body: { roles: [] } },\n  },\n  POST: {\n    description: 'Create a new role (admin only).',\n      request: { body: { name: 'editor', description: 'Can edit content', permissions: ['content:write'] } },\n      response: { status: 201, body: { message: 'Role created', role: { id: 'new-id', name: 'editor', permissions: ['content:write'] } } },\n  },\n};\n\nexport const middlewares = [requireAuth('admin')];\n\nexport const GET = async (_req: Request, res: Response) => {\n  // TODO: fetch all roles\n  res.json({ roles: [] });\n};\n\nexport const POST = async (req: Request, res: Response) => {\n  const { name, description, permissions } = req.body;\n  if (!name) return res.status(400).json({ error: 'name is required' });\n  // TODO: create role\n  res.status(201).json({ message: 'Role created', role: { id: 'new-id', name, permissions: permissions ?? [] } });\n};\n",
  "src/api/admin/users/[id].ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport { User } from '../../../model/User.js';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'Fetch a single user by ID (admin only).',\n    request: { params: { id: 'usr_01HXZ' } },\n    response: { status: 200, body: { user: { id: 'usr_01HXZ', name: 'Jane Doe', email: 'jane@example.com', role: 'user' } } },\n  },\n  PUT: {\n    description: 'Update a user by ID (admin only).',\n    request: { params: { id: 'usr_01HXZ' }, body: { name: 'Jane Doe', email: 'jane@example.com', role: 'user', isActive: true } },\n    response: { status: 200, body: { message: 'User updated', user: { id: 'usr_01HXZ', name: 'Jane Doe', email: 'jane@example.com', role: 'user' } } },\n  },\n  DELETE: {\n    description: 'Delete a user by ID (admin only).',\n    request: { params: { id: 'usr_01HXZ' } },\n    response: { status: 200, body: { message: 'User usr_01HXZ deleted' } },\n  },\n};\n\nexport const middlewares = [requireAuth('admin')];\n\nexport const GET = async (req: Request, res: Response) => {\n  const { id } = req.params;\n  const user = await User.findById(id);\n  if (!user) return res.status(404).json({ error: 'User not found' });\n  const { password: _, ...safe } = user;\n  res.json({ user: safe });\n};\n\nexport const PUT = async (req: Request, res: Response) => {\n  const { id } = req.params;\n  const { name, email, role, isActive } = req.body;\n  const updated = await User.update(id, { name, email, role, isActive });\n  if (!updated) return res.status(404).json({ error: 'User not found' });\n  const { password: _, ...safe } = updated;\n  res.json({ message: 'User updated', user: safe });\n};\n\nexport const DELETE = async (req: Request, res: Response) => {\n  const { id } = req.params;\n  const user = await User.findById(id);\n  if (!user) return res.status(404).json({ error: 'User not found' });\n  await User.delete(id);\n  res.json({ message: `User ${id} deleted` });\n};\n",
  "src/api/admin/users/[id]/activate.ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  POST: {\n    description: 'Reactivate a suspended user account (admin only).',\n      request: { params: { id: 'usr_01HXZ' } },\n      response: { status: 200, body: { message: 'User usr_01HXZ activated' } },\n  },\n};\n\nexport const middlewares = [requireAuth('admin')];\n\nexport const POST = async (req: Request, res: Response) => {\n  const { id } = req.params;\n  // TODO: set user.isActive = true, log audit event\n  res.json({ message: `User ${id} activated` });\n};\n",
  "src/api/admin/users/[id]/suspend.ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  POST: {\n    description: 'Suspend a user account (admin only).',\n      request: { params: { id: 'usr_01HXZ' }, body: { reason: 'Terms of service violation' } },\n      response: { status: 200, body: { message: 'User usr_01HXZ suspended', reason: 'Terms of service violation' } },\n  },\n};\n\nexport const middlewares = [requireAuth('admin')];\n\nexport const POST = async (req: Request, res: Response) => {\n  const { id } = req.params;\n  const { reason } = req.body;\n  // TODO: set user.isActive = false, log audit event\n  res.json({ message: `User ${id} suspended`, reason });\n};\n",
  "src/api/admin/users/[id]/verify.ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  POST: {\n    description: 'Mark a user\\'s email as verified (admin only).',\n      request: { params: { id: 'usr_01HXZ' } },\n      response: { status: 200, body: { message: 'User usr_01HXZ verified' } },\n  },\n};\n\nexport const middlewares = [requireAuth('admin')];\n\nexport const POST = async (req: Request, res: Response) => {\n  const { id } = req.params;\n  // TODO: set user.isVerified = true\n  res.json({ message: `User ${id} verified` });\n};\n",
  "src/api/admin/users/export.ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'Export all users as a CSV download (admin only).',\n      response: { status: 200, body: 'id,name,email,role,createdAt\\n' },\n  },\n};\n\nexport const middlewares = [requireAuth('admin')];\n\nexport const GET = async (_req: Request, res: Response) => {\n  // TODO: generate CSV of all users and stream response\n  res.setHeader('Content-Type', 'text/csv');\n  res.setHeader('Content-Disposition', 'attachment; filename=\"users.csv\"');\n  res.send('id,name,email,role,createdAt\\n');\n};\n",
  "src/api/admin/users/index.ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport bcrypt from 'bcrypt';\nimport { User } from '../../../model/User.js';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'List all users, paginated (admin only).',\n    request: { query: { page: '1', limit: '20' } },\n    response: { status: 200, body: { users: [], total: 0, page: 1, limit: 20 } },\n  },\n  POST: {\n    description: 'Create a new user account (admin only).',\n    request: { body: { name: 'Jane Doe', email: 'jane@example.com', password: 'secret', role: 'user' } },\n    response: { status: 201, body: { message: 'User created', user: { id: 'new-id', name: 'Jane Doe', email: 'jane@example.com', role: 'user' } } },\n  },\n};\n\nexport const middlewares = [requireAuth('admin')];\n\nexport const GET = async (req: Request, res: Response) => {\n  const page = Math.max(1, Number(req.query.page) || 1);\n  const limit = Math.min(100, Number(req.query.limit) || 20);\n  const [all, total] = await Promise.all([User.find({}), User.count({})]);\n  const users = all.slice((page - 1) * limit, page * limit).map(({ password: _, ...u }) => u);\n  res.json({ users, total, page, limit });\n};\n\nexport const POST = async (req: Request, res: Response) => {\n  const { name, email, password, role } = req.body;\n  if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });\n  const existing = await User.findOne({ email });\n  if (existing) return res.status(409).json({ error: 'Email already in use' });\n  const hashed = await bcrypt.hash(password, 10);\n  const user = await User.create({ name, email, password: hashed, role: role ?? 'user' });\n  const { password: _, ...safe } = user;\n  res.status(201).json({ message: 'User created', user: safe });\n};\n",
  "src/api/auth/2fa/disable.ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  POST: {\n    description: 'Disable 2FA for the authenticated user.',\n      request: { body: { code: '123456' } },\n      response: { status: 200, body: { message: '2FA disabled' } },\n  },\n};\n\nexport const middlewares = [requireAuth('user', 'admin')];\n\nexport const POST = async (req: Request, res: Response) => {\n  const { code } = req.body;\n  if (!code) return res.status(400).json({ error: 'code is required' });\n  // TODO: verify code and disable 2FA\n  res.json({ message: '2FA disabled' });\n};\n",
  "src/api/auth/2fa/setup.ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'Generate a TOTP secret and QR code to set up 2FA.',\n      response: { status: 200, body: { qrCode: 'otpauth://totp/...', secret: 'BASE32SECRET' } },\n  },\n  POST: {\n    description: 'Confirm a TOTP code to enable 2FA for the authenticated user.',\n      request: { body: { code: '123456' } },\n      response: { status: 200, body: { message: '2FA enabled' } },\n  },\n};\n\nexport const middlewares = [requireAuth('user', 'admin')];\n\nexport const GET = async (req: Request, res: Response) => {\n  // TODO: generate TOTP secret and return QR code URL\n  res.json({ qrCode: 'otpauth://totp/...', secret: 'BASE32SECRET' });\n};\n\nexport const POST = async (req: Request, res: Response) => {\n  const { code } = req.body;\n  if (!code) return res.status(400).json({ error: 'code is required' });\n  // TODO: verify TOTP code and enable 2FA\n  res.json({ message: '2FA enabled' });\n};\n",
  "src/api/auth/2fa/verify.ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  POST: {\n    description: 'Verify a TOTP code during login.',\n      request: { body: { code: '123456' } },\n      response: { status: 200, body: { message: '2FA verified' } },\n  },\n};\n\nexport const POST = async (req: Request, res: Response) => {\n  const { code } = req.body;\n  if (!code) return res.status(400).json({ error: 'code is required' });\n  // TODO: verify TOTP code\n  res.json({ message: '2FA verified' });\n};\n",
  "src/api/auth/change-password.ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  POST: {\n    description: 'Change password for the authenticated user.',\n      request: { body: { oldPassword: 'current', newPassword: 'newpassword' } },\n      response: { status: 200, body: { message: 'Password changed successfully' } },\n  },\n};\n\nexport const middlewares = [requireAuth('user', 'admin')];\n\nexport const POST = async (req: Request, res: Response) => {\n  const { oldPassword, newPassword } = req.body;\n  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'oldPassword and newPassword are required' });\n  // TODO: verify old password, hash and update new password\n  res.json({ message: 'Password changed successfully' });\n};\n",
  "src/api/auth/forgot-password.ts": "import type { Request, Response } from 'express';\nimport crypto from 'node:crypto';\nimport { User } from '../../model/User.js';\nimport { Admin } from '../../model/Admin.js';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  POST: {\n    description: 'Send a password reset email to the given address.',\n      request: { body: { email: 'user@example.com' } },\n      response: { status: 200, body: { message: 'Reset email sent' } },\n  },\n};\n\nconst RESET_TOKEN_TTL_MS = 1000 * 60 * 60; // 1 hour\n\nexport const POST = async (req: Request, res: Response) => {\n  const { email } = req.body;\n  if (!email) return res.status(400).json({ error: 'email is required' });\n\n  const user = await User.findOne({ email });\n  const admin = user ? null : await Admin.findOne({ email });\n\n  // Always respond the same way whether or not the account exists, so this\n  // endpoint can't be used to enumerate registered emails.\n  if (user || admin) {\n    const resetToken = crypto.randomBytes(32).toString('hex');\n    const resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_TTL_MS);\n    if (user) await User.update(user.id, { resetToken, resetTokenExpiry });\n    else if (admin) await Admin.update(admin.id, { resetToken, resetTokenExpiry });\n    // TODO: email this token to the user — enable the Mailer feature to auto-wire SendEmail\n  }\n\n  res.json({ message: 'Reset email sent' });\n};\n",
  "src/api/auth/login.ts": "import { issueToken } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport bcrypt from 'bcrypt';\nimport crypto from 'node:crypto';\nimport { User } from '../../model/User.js';\nimport { Admin } from '../../model/Admin.js';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  POST: {\n    description: 'Authenticate a user or admin and issue a JWT.',\n    request: { body: { email: 'user@example.com', password: 'user' } },\n    response: { status: 200, body: { message: 'Logged in as user' } },\n  },\n};\n\nconst REFRESH_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days\n\nasync function issueRefreshToken(\n  res: Response,\n  model: { update: (id: string, data: Record<string, unknown>) => Promise<unknown> },\n  id: string,\n): Promise<void> {\n  const refreshToken = crypto.randomBytes(40).toString('hex');\n  await model.update(id, { refreshToken, refreshTokenExpiry: new Date(Date.now() + REFRESH_TOKEN_TTL_MS) });\n  res.cookie('efc_refresh_token', refreshToken, {\n    httpOnly: true,\n    secure: process.env.NODE_ENV === 'production',\n    sameSite: 'strict',\n    maxAge: REFRESH_TOKEN_TTL_MS,\n  });\n}\n\nexport const POST = async (req: Request, res: Response) => {\n  const { email, password } = req.body;\n  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });\n\n  const admin = await Admin.findOne({ email });\n  if (admin) {\n    const match = await bcrypt.compare(password, admin.password);\n    if (!match) return res.status(401).json({ error: 'Invalid credentials' });\n    if (!admin.isActive) return res.status(403).json({ error: 'Account suspended' });\n    await issueToken(res, { id: admin.id, role: admin.role, email: admin.email });\n    await issueRefreshToken(res, Admin, admin.id);\n    return res.json({ message: 'Logged in as admin' });\n  }\n\n  const user = await User.findOne({ email });\n  if (!user) return res.status(401).json({ error: 'Invalid credentials' });\n  const match = await bcrypt.compare(password, user.password);\n  if (!match) return res.status(401).json({ error: 'Invalid credentials' });\n  if (!user.isActive) return res.status(403).json({ error: 'Account suspended' });\n  await issueToken(res, { id: user.id, role: user.role, email: user.email });\n  await issueRefreshToken(res, User, user.id);\n  res.json({ message: 'Logged in' });\n};\n",
  "src/api/auth/logout.ts": "import { revokeToken } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  POST: {\n    description: 'Clear the auth cookie and log the user out.',\n    response: { status: 200, body: { message: 'Logged out successfully' } },\n  },\n};\n\nexport const POST = async (_req: Request, res: Response) => {\n  revokeToken(res);\n  res.clearCookie('efc_refresh_token');\n  res.json({ message: 'Logged out successfully' });\n};\n",
  "src/api/auth/me.ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'Return the currently authenticated user.',\n    response: { status: 200, body: { user: { id: '1', role: 'user', email: 'user@example.com' } } },\n  },\n};\n\nexport const middlewares = [requireAuth('user', 'admin')];\n\nexport const GET = async (req: Request, res: Response) => {\n  res.json({ user: (req as any).user });\n};\n",
  "src/api/auth/refresh.ts": "import { issueToken } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport crypto from 'node:crypto';\nimport { User } from '../../model/User.js';\nimport { Admin } from '../../model/Admin.js';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  POST: {\n    description: 'Refresh the JWT using the refresh-token cookie and issue a new access token.',\n      response: { status: 200, body: { message: 'Token refreshed' } },\n  },\n};\n\nconst REFRESH_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days\n\nexport const POST = async (req: Request, res: Response) => {\n  const token = req.cookies?.['efc_refresh_token'] || req.body?.refreshToken;\n  if (!token) return res.status(401).json({ error: 'Refresh token required' });\n\n  const user = await User.findOne({ refreshToken: token });\n  const admin = user ? null : await Admin.findOne({ refreshToken: token });\n  const account = user || admin;\n\n  if (!account || !account.refreshTokenExpiry || new Date(account.refreshTokenExpiry) < new Date()) {\n    return res.status(401).json({ error: 'Invalid or expired refresh token' });\n  }\n\n  const newRefreshToken = crypto.randomBytes(40).toString('hex');\n  const refreshTokenExpiry = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);\n  if (user) await User.update(user.id, { refreshToken: newRefreshToken, refreshTokenExpiry });\n  else if (admin) await Admin.update(admin.id, { refreshToken: newRefreshToken, refreshTokenExpiry });\n\n  res.cookie('efc_refresh_token', newRefreshToken, {\n    httpOnly: true,\n    secure: process.env.NODE_ENV === 'production',\n    sameSite: 'strict',\n    maxAge: REFRESH_TOKEN_TTL_MS,\n  });\n\n  await issueToken(res, { id: account.id, role: account.role, email: account.email });\n  res.json({ message: 'Token refreshed' });\n};\n",
  "src/api/auth/register.ts": "import type { Request, Response } from 'express';\nimport bcrypt from 'bcrypt';\nimport { User } from '../../model/User.js';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  POST: {\n    description: 'Register a new user account.',\n    request: { body: { name: 'Jane Doe', email: 'jane@example.com', password: 'secret' } },\n    response: { status: 201, body: { message: 'Account created successfully' } },\n  },\n};\n\nexport const POST = async (req: Request, res: Response) => {\n  const { name, email, password } = req.body;\n  if (!name || !email || !password) {\n    return res.status(400).json({ error: 'name, email and password are required' });\n  }\n  const existing = await User.findOne({ email });\n  if (existing) return res.status(409).json({ error: 'Email already in use' });\n  const hashed = await bcrypt.hash(password, 10);\n  // verifyToken is generated by the schema itself (default: '$uuid') — no manual\n  // crypto.randomBytes() call needed here anymore.\n  const user = await User.create({ name, email, password: hashed });\n\n  // TODO: email this token to the user — enable the Mailer feature to auto-wire SendEmail\n\n  const { password: _, verifyToken: __, ...safe } = user;\n  res.status(201).json({ message: 'Account created successfully', user: safe });\n};\n",
  "src/api/auth/reset-password.ts": "import type { Request, Response } from 'express';\nimport bcrypt from 'bcrypt';\nimport { User } from '../../model/User.js';\nimport { Admin } from '../../model/Admin.js';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  POST: {\n    description: 'Reset password using a valid reset token.',\n      request: { body: { token: 'reset-token', password: 'newpassword' } },\n      response: { status: 200, body: { message: 'Password reset successfully' } },\n  },\n};\n\nexport const POST = async (req: Request, res: Response) => {\n  const { token, password } = req.body;\n  if (!token || !password) return res.status(400).json({ error: 'token and password are required' });\n\n  const user = await User.findOne({ resetToken: token });\n  const admin = user ? null : await Admin.findOne({ resetToken: token });\n  const account = user || admin;\n\n  if (!account || !account.resetTokenExpiry || new Date(account.resetTokenExpiry) < new Date()) {\n    return res.status(400).json({ error: 'Invalid or expired reset token' });\n  }\n\n  const hashed = await bcrypt.hash(password, 10);\n  if (user) await User.update(user.id, { password: hashed, resetToken: '' });\n  else if (admin) await Admin.update(admin.id, { password: hashed, resetToken: '' });\n\n  res.json({ message: 'Password reset successfully' });\n};\n",
  "src/api/auth/sessions/[id].ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  DELETE: {\n    description: 'Revoke a single active session by ID.',\n      request: { params: { id: 'sess_01HXZ' } },\n      response: { status: 200, body: { message: 'Session sess_01HXZ revoked' } },\n  },\n};\n\nexport const middlewares = [requireAuth('user', 'admin')];\n\nexport const DELETE = async (req: Request, res: Response) => {\n  const { id } = req.params;\n  // TODO: revoke session by id\n  res.json({ message: `Session ${id} revoked` });\n};\n",
  "src/api/auth/sessions/index.ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'List all active sessions for the authenticated user.',\n      response: { status: 200, body: { sessions: [] } },\n  },\n};\n\nexport const middlewares = [requireAuth('user', 'admin')];\n\nexport const GET = async (req: Request, res: Response) => {\n  // TODO: fetch sessions for req.user.id\n  res.json({ sessions: [] });\n};\n",
  "src/api/health.ts": "import type { Request, Response } from 'express';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: 'Health check — returns server status and current timestamp.',\n    response: { status: 200, body: { status: 'OK', timestamp: '2024-01-01T00:00:00.000Z' } },\n  },\n};\n\nexport const GET = async (_req: Request, res: Response) => {\n  res.json({ status: 'OK', timestamp: new Date().toISOString() });\n};\n",
  "src/api/user/profile.ts": "import { requireAuth } from 'express-file-cluster/auth';\nimport type { Request, Response } from 'express';\nimport { User } from '../../model/User.js';\nimport type { RouteMeta } from 'express-file-cluster';\n\nexport const meta: RouteMeta = {\n  GET: {\n    description: \"Fetch the authenticated user's profile.\",\n    response: { status: 200, body: { user: { id: '1', role: 'user', email: 'user@example.com' } } },\n  },\n  PUT: {\n    description: \"Update the authenticated user's profile.\",\n    request: { body: { name: 'Jane Doe', email: 'jane@example.com' } },\n    response: { status: 200, body: { message: 'Profile updated', user: { id: '1', role: 'user', email: 'jane@example.com' } } },\n  },\n};\n\nexport const middlewares = [requireAuth('user', 'admin')];\n\nexport const GET = async (req: Request, res: Response) => {\n  const { id } = (req as any).user;\n  const user = await User.findById(id);\n  if (!user) return res.status(404).json({ error: 'User not found' });\n  const { password: _, ...safe } = user;\n  res.json({ user: safe });\n};\n\nexport const PUT = async (req: Request, res: Response) => {\n  const { id } = (req as any).user;\n  const { name, email } = req.body;\n  const updated = await User.update(id, { name, email });\n  if (!updated) return res.status(404).json({ error: 'User not found' });\n  const { password: _, ...safe } = updated;\n  res.json({ message: 'Profile updated', user: safe });\n};\n",
  "src/index.ts": "import { ignite, gracefulShutdown } from 'express-file-cluster';\nimport config from '../efc.config.js';\n\n// Every runtime value (PORT, DATABASE_URL, JWT_SECRET, CORS_ORIGINS, ...) is wired from\n// .env in efc.config.ts and spread in below — ignite() itself never touches process.env\n// for these, so this object is the single source of truth for what's actually applied.\nignite({\n  ...config,\n  cluster: true,\n}).then(gracefulShutdown).catch(console.error);\n",
  "src/model/Admin.ts": "import { defineModel } from 'express-file-cluster';\n\nexport interface AdminDocument {\n  name: string;\n  email: string;\n  password: string;\n  role: string;\n  permissions: string[];\n  isActive: boolean;\n  adminNumber: number;\n  createdBy?: string;\n  resetToken?: string;\n  resetTokenExpiry?: Date;\n  refreshToken?: string;\n  refreshTokenExpiry?: Date;\n}\n\nexport const Admin = defineModel<AdminDocument>('Admin', {\n  name:               { type: 'string',  required: true },\n  email:              { type: 'string',  required: true, unique: true },\n  password:           { type: 'string',  required: true },\n  role:               { type: 'string',  required: true, default: 'admin' },\n  permissions:        { type: 'array',   default: [] },\n  isActive:           { type: 'boolean', default: true },\n  // Auto-incrementing, human-friendly admin number — see FieldDefinition.sequence\n  adminNumber:        { type: 'number',  sequence: true },\n  // Who created this admin account, read live from the authenticated request —\n  // see the '$currentUser.<key>' default operator code\n  createdBy:          { type: 'string',  default: '$currentUser.id' },\n  resetToken:         { type: 'string' },\n  resetTokenExpiry:   { type: 'date' },\n  refreshToken:       { type: 'string' },\n  refreshTokenExpiry: { type: 'date' },\n});\n",
  "src/model/Role.ts": "import { defineModel } from 'express-file-cluster';\n\nexport interface RoleDocument {\n  name: string;\n  description: string;\n  permissions: string[];\n  createdOn: Date;\n}\n\n// Roles rarely need an 'updatedAt' audit trail, so timestamps are turned off —\n// but createdOn is kept as an explicitly-named creation-moment field instead,\n// via the '$now' default operator code (see ModelOptions / DefaultOperator).\nexport const Role = defineModel<RoleDocument>(\n  'Role',\n  {\n    name:        { type: 'string', required: true, unique: true },\n    description: { type: 'string', required: true },\n    permissions: { type: 'array',  default: [] },\n    createdOn:   { type: 'date',   default: '$now' },\n  },\n  { timestamps: false },\n);\n",
  "src/model/Session.ts": "import { defineModel } from 'express-file-cluster';\n\nexport interface SessionDocument {\n  userId: string;\n  token: string;\n  ip: string;\n  userAgent: string;\n  expiresAt: Date;\n  isActive: boolean;\n}\n\nexport const Session = defineModel<SessionDocument>('Session', {\n  userId:    { type: 'string',  required: true },\n  // A fresh crypto.randomUUID() per session, generated by the schema itself —\n  // see the '$uuid' default operator code\n  token:     { type: 'string',  required: true, unique: true, default: '$uuid' },\n  ip:        { type: 'string',  required: true },\n  userAgent: { type: 'string',  required: true },\n  expiresAt: { type: 'date',    required: true },\n  isActive:  { type: 'boolean', default: true },\n});\n",
  "src/model/User.ts": "import { defineModel } from 'express-file-cluster';\n\nexport interface UserDocument {\n  name: string;\n  email: string;\n  password: string;\n  role: string;\n  avatar?: string;\n  isVerified: boolean;\n  isActive: boolean;\n  verifyToken?: string;\n  resetToken?: string;\n  resetTokenExpiry?: Date;\n  refreshToken?: string;\n  refreshTokenExpiry?: Date;\n}\n\nexport const User = defineModel<UserDocument>('User', {\n  name:               { type: 'string',  required: true },\n  email:              { type: 'string',  required: true, unique: true },\n  password:           { type: 'string',  required: true },\n  role:               { type: 'string',  required: true, default: 'user' },\n  avatar:             { type: 'string' },\n  isVerified:         { type: 'boolean', default: false },\n  isActive:           { type: 'boolean', default: true },\n  // Generated automatically on signup — no need for the route handler to\n  // compute this itself. resetToken/refreshToken stay bare: they're only ever\n  // set later, on demand (forgot-password / refresh flows), never at creation.\n  verifyToken:        { type: 'string', default: '$uuid' },\n  resetToken:         { type: 'string' },\n  resetTokenExpiry:   { type: 'date' },\n  refreshToken:       { type: 'string' },\n  refreshTokenExpiry: { type: 'date' },\n});\n",
  "src/tasks/SendEmail.ts": "import { defineTask } from 'express-file-cluster/tasks';\n\ninterface SendEmailPayload {\n  to: string;\n  subject: string;\n  body: string;\n}\n\nexport default defineTask<SendEmailPayload>(async (payload) => {\n  // TODO: wire up your mailer\n  console.log('[SendEmail] Sending to', payload.to);\n});\n",
  "efc.config.ts": "import type { EFCConfig } from 'express-file-cluster';\n\n// The framework never reads process.env itself — every runtime value it needs is read\n// here, explicitly, and passed in. Edit .env to change values; edit this file to change\n// which env vars are wired up or add new ones.\nconst corsOrigins = process.env.CORS_ORIGINS\n  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)\n  : undefined;\n\nconst config: EFCConfig = {\n  port: process.env.PORT ? Number(process.env.PORT) : undefined,\n  databaseUrl: process.env.DATABASE_URL,\n  jwtSecret: process.env.JWT_SECRET,\n  jwtExpiresIn: process.env.JWT_EXPIRES_IN,\n  cookieDomain: process.env.COOKIE_DOMAIN,\n  cors: corsOrigins ? { origin: corsOrigins } : true,\n  authStrategy: 'http-only',\n  tasks: { backend: 'bullmq', concurrency: 5, redisUrl: process.env.REDIS_URL },\n  globalMiddlewares: [],\n};\n\nexport default config;\n",
  "package.json": "{\n  \"name\": \"workspace\",\n  \"version\": \"0.1.0\",\n  \"type\": \"module\",\n  \"scripts\": {\n    \"dev\": \"efc start dev\",\n    \"build\": \"efc build prod\",\n    \"start\": \"efc start prod\",\n    \"test\": \"efc run tests\"\n  },\n  \"dependencies\": {\n    \"express-file-cluster\": \"^0.4.0\",\n    \"mongoose\": \"^8.0.0\",\n    \"bullmq\": \"^5.0.0\",\n    \"bcrypt\": \"^5.1.0\"\n  },\n  \"devDependencies\": {\n    \"vitest\": \"^4.1.9\",\n    \"typescript\": \"^5.5.0\",\n    \"@types/node\": \"^22.0.0\",\n    \"@types/express\": \"^4.17.21\",\n    \"tsup\": \"^8.2.0\",\n    \"tsx\": \"^4.0.0\",\n    \"@types/bcrypt\": \"^5.0.0\"\n  }\n}\n",
  ".env.example": "PORT=3000\nNODE_ENV=development\nDATABASE_URL=mongodb://localhost:27017/workspace\nJWT_SECRET=<generate with: openssl rand -hex 64>\nREDIS_URL=redis://localhost:6379\nCORS_ORIGINS=http://localhost:3000,https://yourapp.com",
};

/* ─── LIGHTWEIGHT SYNTAX HIGHLIGHTER ─── */
const KEYWORDS = /\b(import|from|export|const|let|var|async|await|function|return|if|else|throw|new|type|interface|default|class|extends|typeof|void|true|false|null|undefined)\b/;
const EFC_SYMBOLS = /\b(ignite|gracefulShutdown|defineModel|defineTask|enqueue|HttpError|isHttpError|issueToken|requireAuth|revokeToken|signToken|compose|db|EFCConfig|RouteMeta|Request|Response|Number|String|Boolean|Date|Array|Object|Promise)\b/;

const TOKEN_RE = new RegExp(
  [
    '(//.*$)',
    "('(?:[^'\\\\]|\\\\.)*'|\"(?:[^\"\\\\]|\\\\.)*\"|`(?:[^`\\\\]|\\\\.)*`)",
    '(\\b\\d+(?:\\.\\d+)?\\b)',
    KEYWORDS.source, // already a capturing group: \b(import|...)\b
    EFC_SYMBOLS.source, // already a capturing group: \b(ignite|...)\b
  ].join('|'),
  'gm',
);

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightLine(line) {
  return escapeHtml(line).replace(TOKEN_RE, (m, comment, str, num, kw, sym) => {
    if (comment) return `<span class="c-dim">${comment}</span>`;
    if (str) return `<span class="c-green">${str}</span>`;
    if (num) return `<span class="c-orange">${num}</span>`;
    if (kw) return `<span class="c-purple">${kw}</span>`;
    if (sym) return `<span class="c-blue">${sym}</span>`;
    return m;
  });
}

function fileIcon(path) {
  if (path.endsWith('.ts')) return '<span class="ico ico-ts">TS</span>';
  if (path.endsWith('.json')) return '<span class="ico ico-json">{}</span>';
  return '<span class="ico ico-env">•</span>';
}

/* ─── STATE ─── */
let openTabs = ['src/index.ts', 'src/api/auth/login.ts', 'src/model/User.ts'];
let activePath = 'src/index.ts';

const tabbarEl = document.getElementById('tabbar');
const breadcrumbsEl = document.getElementById('breadcrumbs');
const editorCodeEl = document.getElementById('editorCode');
const editorEmptyEl = document.getElementById('editorEmpty');

function render() {
  // tabs
  tabbarEl.innerHTML = openTabs
    .map((path) => {
      const label = path.split('/').pop();
      const active = path === activePath ? ' active' : '';
      return `<div class="tab-item${active}" data-path="${path}">${fileIcon(path)}<span>${label}</span><span class="tab-close" data-close="${path}">&times;</span></div>`;
    })
    .join('');

  // sidebar active state
  document.querySelectorAll('.tree-file').forEach((li) => {
    li.classList.toggle('active', li.dataset.path === activePath);
  });

  if (!activePath) {
    editorEmptyEl.style.display = 'flex';
    editorCodeEl.style.display = 'none';
    breadcrumbsEl.innerHTML = '';
    return;
  }

  editorEmptyEl.style.display = 'none';
  editorCodeEl.style.display = 'block';

  // breadcrumb
  const segs = activePath.split('/');
  breadcrumbsEl.innerHTML = segs
    .map((s, i) => (i === segs.length - 1 ? `<span class="crumb-last">${s}</span>` : `<span>${s}</span> <span>›</span>`))
    .join(' ');

  // editor content
  const lines = FILES[activePath].replace(/\n$/, '').split('\n');
  editorCodeEl.innerHTML = lines
    .map((line, i) => `<div class="code-line"><span class="ln">${i + 1}</span><span class="lc">${highlightLine(line) || ' '}</span></div>`)
    .join('');
}

function openFile(path) {
  if (!openTabs.includes(path)) openTabs.push(path);
  activePath = path;
  render();
}

function closeTab(path) {
  const idx = openTabs.indexOf(path);
  if (idx === -1) return;
  openTabs.splice(idx, 1);
  if (activePath === path) {
    activePath = openTabs[idx] || openTabs[idx - 1] || null;
  }
  render();
}

/* ─── SIDEBAR: file tree clicks ─── */
document.getElementById('fileTree').addEventListener('click', (e) => {
  const folderRow = e.target.closest('.folder-row');
  if (folderRow) {
    folderRow.closest('.tree-folder').classList.toggle('open');
    return;
  }
  const fileRow = e.target.closest('.tree-file');
  if (fileRow) openFile(fileRow.dataset.path);
});

/* ─── TAB BAR: click to activate / close ─── */
tabbarEl.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('.tab-close');
  if (closeBtn) {
    e.stopPropagation();
    closeTab(closeBtn.dataset.close);
    return;
  }
  const tab = e.target.closest('.tab-item');
  if (tab) {
    activePath = tab.dataset.path;
    render();
  }
});

/* ─── ACTIVITY BAR: only Explorer has a real view; others just toggle focus ─── */
document.querySelectorAll('.ab-icon').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ab-icon').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

/* ─── MOBILE: toggle the sidebar overlay ─── */
const menuToggle = document.getElementById('menuToggle');
const sidebarEl = document.getElementById('sidebar');
if (menuToggle) {
  menuToggle.addEventListener('click', () => sidebarEl.classList.toggle('open'));
  document.getElementById('ide').addEventListener('click', (e) => {
    if (window.innerWidth <= 860 && !e.target.closest('.sidebar') && !e.target.closest('#menuToggle')) {
      sidebarEl.classList.remove('open');
    }
  });
}

/* ─── TERMINAL SIMULATION ─── */
const TERMINAL_SEQUENCE = [
  { html: '<span class="c-dim">$</span> npm run dev', delay: 150 },
  { html: '<span class="c-dim">&gt; workspace@0.1.0 dev</span>', delay: 260 },
  { html: '<span class="c-dim">&gt; efc start dev</span>', delay: 260 },
  { html: '', delay: 200 },
  { html: '[EFC] Pre-Flight: connecting to MongoDB&hellip;', delay: 500 },
  { html: '[EFC] MongoDB connected', delay: 350 },
  { html: '[EFC] Worker primary listening on :3000', delay: 450 },
  { html: '', delay: 350 },
  { html: '<span class="c-dim">$</span> curl http://localhost:3000/v1/api/health', delay: 500 },
  { html: '<span class="c-green">{"status":"OK","timestamp":"2026-07-18T21:00:00.000Z"}</span>', delay: 400 },
  { html: '', delay: 350 },
  { html: '<span class="c-dim">$</span> curl -X POST http://localhost:3000/v1/api/auth/register \\', delay: 500 },
  { html: "  -d '{\"name\":\"Ada\",\"email\":\"ada@efc.dev\",\"password\":\"secret\"}'", delay: 300 },
  { html: '<span class="c-green">{"message":"Account created successfully","user":{"id":"66a1f0c2b9d4e8f1a2b3c4d5", ...}}</span>', delay: 450 },
  { html: '', delay: 350 },
  { html: '<span class="c-dim">$</span> curl -X POST http://localhost:3000/v1/api/auth/login \\', delay: 500 },
  { html: "  -d '{\"email\":\"ada@efc.dev\",\"password\":\"secret\"}'", delay: 300 },
  { html: '<span class="c-green">{"message":"Logged in"}</span>', delay: 400 },
  { html: '', delay: 350 },
  { html: '<span class="c-dim"># as an authenticated admin (Cookie: efc_token=&lt;jwt&gt;) — createdBy and</span>', delay: 400 },
  { html: '<span class="c-dim"># adminNumber below come from the schema itself, not this request body:</span>', delay: 300 },
  { html: '<span class="c-dim">$</span> curl -X POST http://localhost:3000/v1/api/admin/admins \\', delay: 500 },
  { html: "  -d '{\"name\":\"Grace Hopper\",\"email\":\"grace@efc.dev\",\"password\":\"secret\"}'", delay: 300 },
  { html: '<span class="c-green">{"message":"Admin created","admin":{"id":"66a1f0c2b9d4e8f1a2b3c4d6","adminNumber":2,"name":"Grace Hopper","email":"grace@efc.dev","role":"admin","createdBy":"66a1f0c2b9d4e8f1a2b3c4d5", ...}}</span>', delay: 450 },
];

const terminalBody = document.getElementById('terminalBody');
const runBtn = document.getElementById('runBtn');
const sbWorkers = document.getElementById('sbWorkers');
const sbDot = document.getElementById('sbDot');
let running = false;

function appendTermLine(html) {
  const div = document.createElement('div');
  div.className = 'term-line';
  div.innerHTML = html;
  terminalBody.appendChild(div);
  terminalBody.scrollTop = terminalBody.scrollHeight;
}

function playSequence(i) {
  if (i >= TERMINAL_SEQUENCE.length) {
    appendTermLine('<span class="c-dim">$</span><span class="term-cursor"></span>');
    terminalBody.scrollTop = terminalBody.scrollHeight;
    running = false;
    runBtn.disabled = false;
    runBtn.textContent = '↻ Restart';
    sbWorkers.textContent = '4 workers online';
    sbDot.classList.add('on');
    return;
  }
  const step = TERMINAL_SEQUENCE[i];
  setTimeout(() => {
    appendTermLine(step.html);
    playSequence(i + 1);
  }, step.delay);
}

runBtn.addEventListener('click', () => {
  if (running) return;
  running = true;
  runBtn.disabled = true;
  sbDot.classList.remove('on');
  sbWorkers.textContent = 'booting…';
  terminalBody.innerHTML = '';
  playSequence(0);
});

/* ─── ENTRANCE ANIMATION: replay the create-efc-app scaffold prompts ─── */
const SCAFFOLD_STEPS = [
  { q: 'Project name:', a: 'Workspace' },
  { q: 'Language:', a: 'TypeScript' },
  { q: 'Database:', a: 'MongoDB' },
  { q: 'Authentication strategy:', a: 'http-only' },
  {
    q: 'Features: (space to toggle, enter to confirm)',
    list: [
      { label: 'Multi-core clustering', selected: true },
      { label: 'Background tasks', selected: true },
      { label: 'API route documentation', selected: true },
      { label: 'User portal', selected: true },
      { label: 'Admin portal', selected: true },
      { label: 'Role-based access control', selected: true },
    ],
    summary: 'Multi-core clustering, Background tasks, API route documentation, User portal, Admin portal, Role-based access control',
  },
  {
    q: 'User portal features: (space to toggle, enter to confirm)',
    list: [
      { label: 'Profile viewing & editing', selected: true },
      { label: 'Forgot / reset password', selected: true },
      { label: 'Change password', selected: true },
      { label: '2FA & sessions', selected: true },
    ],
    summary: 'Profile viewing & editing, Forgot / reset password, Change password, 2FA & sessions',
  },
  {
    q: 'Admin panel features: (space to toggle, enter to confirm)',
    list: [
      { label: 'User management', selected: true },
      { label: 'Admin & role management', selected: true },
      { label: 'Analytics (users, revenue, traffic dashboards)', selected: false },
      { label: 'Content management', selected: false },
      { label: 'Billing management', selected: false },
      { label: 'Support tickets', selected: false },
      { label: 'Notifications & audit logs', selected: false },
      { label: 'System settings & health', selected: false },
    ],
    summary: 'User management, Admin & role management',
  },
  {
    q: 'Task queue backend:',
    list: [
      { label: 'BullMQ (Redis)', selected: true },
      { label: 'pg-boss', selected: false },
    ],
    radio: true,
    summary: 'BullMQ',
  },
  { q: 'Project created' },
  { q: 'Installing dependencies….', spinner: true },
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runIntro() {
  const stepsEl = document.getElementById('introSteps');
  // .intro-card is the actual scrolling container (overflow-y: auto) — #introSteps
  // is just a plain child, so scrollTop must be set on its scrolling ancestor or
  // nothing visibly happens (the animation keeps advancing invisibly below the fold).
  const scrollEl = stepsEl.closest('.intro-card');
  const overlayEl = document.getElementById('introOverlay');
  const ideEl = document.getElementById('ide');

  const scrollToEnd = () => {
    if (scrollEl.scrollHeight > scrollEl.clientHeight) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  };

  // Real npx UX: the package isn't cached yet, so npx confirms before installing it.
  const cmdLine = document.createElement('div');
  cmdLine.className = 'intro-cmd';
  cmdLine.innerHTML = '<span class="c-dim">$</span> npx create-efc-app@latest';
  stepsEl.appendChild(cmdLine);
  scrollToEnd();
  await wait(500);

  const npxLine = document.createElement('div');
  npxLine.className = 'intro-npx';
  npxLine.innerHTML =
    'Need to install the following packages:<br>' +
    'create-efc-app@latest<br>' +
    'Ok to proceed? (y) <span class="npx-answer"></span><span class="term-cursor"></span>';
  stepsEl.appendChild(npxLine);
  scrollToEnd();
  await wait(750);
  npxLine.querySelector('.npx-answer').textContent = 'y';
  npxLine.querySelector('.term-cursor').remove();
  await wait(550);

  const banner = document.createElement('div');
  banner.className = 'intro-banner';
  banner.textContent = 'create-efc-app';
  stepsEl.appendChild(banner);
  scrollToEnd();
  await wait(300);

  for (const step of SCAFFOLD_STEPS) {
    const stepEl = document.createElement('div');
    stepEl.className = 'intro-step';

    const head = document.createElement('div');
    head.className = 'step-head';
    head.innerHTML = `<span class="step-icon active">◆</span><span>${step.q}</span>`;
    stepEl.appendChild(head);
    stepsEl.appendChild(stepEl);
    scrollToEnd();
    await wait(180);

    const body = document.createElement('div');
    body.className = 'step-body';
    stepEl.appendChild(body);

    if (step.spinner) {
      body.innerHTML = '<span class="step-bar">│</span><span class="spinner-dot">●</span>';
      scrollToEnd();
      await wait(1500);
    } else if (step.list) {
      for (const item of step.list) {
        const row = document.createElement('div');
        row.className = 'step-row';
        const mark = step.radio ? (item.selected ? '●' : '○') : item.selected ? '■' : '□';
        row.innerHTML = `<span class="step-bar">│</span><span class="mark${item.selected ? ' sel' : ''}">${mark}</span><span class="item-label">${item.label}</span>`;
        body.appendChild(row);
        await wait(70);
      }
      scrollToEnd();
      await wait(450);
      body.innerHTML = `<span class="step-bar">│</span><span class="step-a">${step.summary}</span>`;
    } else if (step.a) {
      body.innerHTML = `<span class="step-bar">│</span><span class="step-a">${step.a}</span>`;
      await wait(220);
    }

    const icon = head.querySelector('.step-icon');
    icon.className = 'step-icon done';
    icon.textContent = '◇';
    scrollToEnd();
    await wait(140);
  }

  await wait(500);
  overlayEl.classList.add('intro-hide');
  await wait(450);
  overlayEl.remove();
  ideEl.classList.add('ide-enter');
}

/* ─── INIT ─── */
render();
runIntro();
