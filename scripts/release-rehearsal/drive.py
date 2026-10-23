import fcntl, os, pty, re, select, struct, sys, termios, time
# Drives the real, interactive `npx create-efc-app` through a pseudo-terminal, answering
# each prompt the way a user would (defaults, except the choices passed in).
# Usage: drive.py <state dir> <workdir> <name> <language: ts|js> <database: mongodb|postgresql> <tasks: bullmq|pg-boss>
S, workdir, name, lang, db, backend = sys.argv[1:7]
env = dict(os.environ, npm_config_userconfig=f'{S}/npmrc', npm_config_cache=f'{S}/cache',
           npm_config_prefix=f'{S}/global', FORCE_COLOR='0', TERM='xterm-256color')
DOWN, ENTER, SPACE = '\x1b[B', '\r', ' '
# Feature picker rows (cursor starts on the first group header): 0 Auth, 1 auth, 2 auth@google,
# 3 auth@apple, 4 User portal (+9 items), 14 Admin portal (+9 items), 24 Integrations.
# Picks auth and both portal groups; OAuth and the email client ask for credentials, so they stay off.
features = DOWN + SPACE + DOWN * 3 + SPACE + DOWN * 10 + SPACE + ENTER
steps = [
    ('Project name', name + ENTER),
    ('Language', (DOWN if lang == 'js' else '') + ENTER),
    ('Database', (DOWN if db == 'postgresql' else '') + ENTER),
    *([('Models:', ENTER)] if db == 'postgresql' else []),  # default: defineTable
    ('Task queue backend', (DOWN if db == 'postgresql' and backend == 'bullmq' else '') + ENTER),
    ('Multi-core clustering', ENTER),
    ('Add features now', features),
    ('Authentication strategy', ENTER),
]
pid, fd = pty.fork()
if pid != 0:
    # A fresh pty is 0x0; prompt libraries wrap to the width, i.e. after every character.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
if pid == 0:
    os.chdir(workdir)
    os.execvpe('npx', ['npx', '-y', f"create-efc-app@{os.environ['CEA_VERSION']}"], env)
out = ''
strip = lambda s: re.sub(r'\x1b(\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_]|\][^\x07]*\x07)', '', s)
def read(timeout):
    global out
    r, _, _ = select.select([fd], [], [], timeout)
    if r:
        try:
            data = os.read(fd, 65536).decode(errors='replace')
        except OSError:
            return False
        out += data
        return True
    return True
for prompt, keys in steps:
    deadline = time.time() + 180
    while prompt not in strip(out):
        if time.time() > deadline:
            open(f'{S}/last-run.txt','w').write(strip(out)); print('TIMEOUT waiting for', prompt); sys.exit(2)
        if not read(1): break
    time.sleep(0.4)
    os.write(fd, keys.encode())
deadline = time.time() + 900
while time.time() < deadline:
    if not read(2): break
    if 'Your project is ready' in strip(out) or 'npm install failed' in strip(out) or 'Error' in strip(out)[-300:]:
        time.sleep(1); read(1)
        if 'Your project is ready' in strip(out): break
_, status = os.waitpid(pid, 0)
open(f'{S}/last-run.txt','w').write(strip(out))
print(strip(out)[-1500:])
code = os.waitstatus_to_exitcode(status)
print('EXIT', code)
sys.exit(code)
