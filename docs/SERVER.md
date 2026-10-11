# Run First Twenty on your own server

First Twenty works in a browser with no server at all. This guide is for when you want your company's
data in your own Postgres database instead: every change syncs to the server, any computer you sign in
from sees the same data, and the database is backed up every night.

You will set up the **First Twenty server** on the same EC2 instance that already runs your Postgres.
Plan on about an hour the first time. Every command is here; copy them one at a time and read what each
one prints before moving on.

## What you get

```
  your browser ──HTTPS 443──> Caddy ──> First Twenty server ──> Postgres
                              (on the EC2 instance: 127.0.0.1:8787, then localhost:5432)
```

- **The app at your own address**, for example `https://hr.example.com`, with a real HTTPS certificate
  that renews itself (Caddy handles this).
- **The First Twenty server**, a small Node.js program that serves the app and its `/api`. It listens
  only on `127.0.0.1:8787`, so the internet reaches it only through Caddy.
- **Your data in Postgres**: one table per kind of record (people, candidates, jobs, and so on), each row
  holding the record as JSON. Postgres listens only on localhost; port 5432 is never opened.
- **One admin login** that protects the data (see [One admin login](#one-admin-login-and-the-path-to-team-logins)).
- **Nightly backups** of the database, kept for 14 days, optionally copied to S3.
- **Offline keeps working.** The browser keeps its own copy, queues changes while offline, and catches up
  when the connection returns. Once a browser has opened the app from your server's address, it opens it
  again even while the server cannot be reached (a new tab, a laptop restart): a small offline worker
  keeps the app page, never your data, and the app starts from the browser's own copy and says Offline.
  The worker always asks your server first: a browser whose offline storage is broken or full still
  opens the app normally, it just has no offline copy.

The kit lives in `server/deploy/`, plus `.env.example` in the project root:

| File | What it is |
|---|---|
| `setup-ec2.sh` | One-time setup: Node.js, Caddy, the service user, folders, settings file, services, backups. Safe to run again. |
| `postgres-setup.sql` | Creates the `first_twenty` database and its two login roles: `first_twenty_owner`, which owns the tables and runs migrations, and `first_twenty`, which the server uses to read and write rows. |
| `first-twenty.service` | The systemd service that runs the server, sandboxed: read-only code, loopback-only network, no privileged system calls. |
| `Caddyfile` | HTTPS and the reverse proxy to the server. |
| `deploy.sh` | Updates the server to the latest code: pull, install, build, back up the database when migrations are pending, migrate, restart, health check. |
| `with-env.sh` | Runs a command (migrations, creating the admin) with the server's settings. |
| `backup.sh`, `first-twenty-backup.service`, `first-twenty-backup.timer` | The nightly backup. |
| `.env.example` (project root) | Every setting the server reads, with a one-line explanation each. |

## Before you start

You need:

1. **An EC2 instance running Postgres 13 or newer**, on Amazon Linux 2023 or Ubuntu 22.04 / 24.04.
   Check the version on the instance with `sudo -u postgres psql -tAc 'SHOW server_version'`.
   An instance with 2 GB of memory or more builds comfortably. On a smaller one, such as a t3.micro
   (about 900 MB), setup adds a 2 GB swap file so the build fits (see step 2).
2. **An Elastic IP attached to the instance**, so its address never changes. In the EC2 console:
   Network & Security > Elastic IPs > Allocate, then Associate it with your instance.
3. **A domain name pointed at that Elastic IP**: an `A` record such as `hr.example.com` with the Elastic IP
   as its value, at whoever runs your DNS. Check it from your computer with `nslookup hr.example.com`;
   it must show the Elastic IP before Caddy can get a certificate. No domain yet? See
   [A free sslip.io name instead](#a-free-sslipio-name-instead).
4. **SSH access** to the instance with your key file. The login is `ec2-user` on Amazon Linux and
   `ubuntu` on Ubuntu. The examples below use `ec2-user` and `your-key.pem`; swap in yours.
5. **The First Twenty code**, either in a private Git repository (GitHub or similar) or on your computer.

Commands marked "on your computer" run in PowerShell or Git Bash in the project folder. Everything else
runs on the instance after you connect with (use the Elastic IP until DNS has caught up):

```bash
ssh -i your-key.pem ec2-user@hr.example.com
```

### A free sslip.io name instead

[sslip.io](https://sslip.io) answers any name that contains an IP address with that address, so
`hr-3-14-15-92.sslip.io` (the Elastic IP with dashes) works with no DNS setup, and Caddy can get a real
certificate for it. It is fine to start with, but a domain you own is better for good:

- **Strangers share the name.** sslip.io is not on the Public Suffix List, so every other
  `*.sslip.io` site, run by anyone, counts as the same site as yours. The server's defenses do not rely on
  that (its sign-in cookie is a `__Host-` cookie no other site can set or replace, and writes need a
  header no other page can send), but a page on another `*.sslip.io` name that you open can still stuff
  your browser with cookies for all of `sslip.io`, until every request to your site fails (Caddy or the
  server answers `431`). Clearing the site data for `sslip.io` in your browser fixes that, and also
  deletes the app's local copy and any changes not yet synced, so check that the header says Synced first
  if you can.
- **Certificates.** Let's Encrypt limits how many certificates one registered domain gets per week, and
  every sslip.io user shares those limits (sslip.io asks for raises, so far with success). If Caddy logs a
  rate-limit error, it retries on its own.
- **Only the Elastic IP.** Use the name of the Elastic IP, never of an address the instance had before:
  once released, an address goes to another AWS customer, who can then get a certificate for its name.

To move to your own domain later, re-run setup with it and set `PUBLIC_ORIGIN` to it. Each address keeps
its own cookies and browser storage, so at the new address sign in from **Settings > Server** and choose
**Use the server's copy**.

### Security group

In the EC2 console, open the instance's security group and make the inbound rules look like this:

| Port | Source | Why |
|---|---|---|
| 443 (HTTPS) | Anywhere (0.0.0.0/0) | The app. |
| 80 (HTTP) | Anywhere (0.0.0.0/0) | Lets Caddy prove it owns the domain to get the certificate, and redirects http:// to https://. |
| 22 (SSH) | My IP only | Your SSH access. Update it when your IP changes. |
| 5432 (Postgres) | **No rule** | Postgres must never be reachable from the internet. Delete this rule if one exists. |

Add `::/0` to the first two only if you give the instance an IPv6 address (EC2 instances have none by
default). With IPv6, one client can hold a whole range of addresses, so the sign-in limits count each
IPv6 network (/64) as one address. Leave UDP 443 closed: Caddy is set up without HTTP/3, which would
need it.

Leave the outbound rules at their default (all traffic), so the instance can reach package mirrors and
the certificate authority.

## Step 1: create the database roles

First Twenty uses two Postgres logins, both limited to the `first_twenty` database (see
[Two database roles](#two-database-roles)):

- `first_twenty`: what the running server uses. It can read, add, change and delete rows, and nothing
  else. It cannot create, change or drop tables.
- `first_twenty_owner`: owns the tables. Only `npm run server:migrate` (during setup and each update) and
  `npm run server:after-restore` use it.

Neither can create other databases, roles or extensions. The script is safe to run more than once and
does not touch any other database on the instance.

**Already ran `postgres-setup.sql` on this instance?** Then the database and both roles exist: skip this
step, do step 2, and follow [If your database and roles already exist](#if-your-database-and-roles-already-exist)
in step 3 to give the roles new passwords.

1. Make two long random passwords, one per role, and keep them somewhere safe for a moment (you paste
   them in step 3). Run this twice; the form avoids characters that would need escaping later:

   ```bash
   openssl rand -base64 33 | tr -d '/+=\n'; echo
   ```

2. Copy the script to the instance (on your computer):

   ```bash
   scp -i your-key.pem server/deploy/postgres-setup.sql ec2-user@hr.example.com:~
   ```

3. Run it as the Postgres superuser (on the instance). It asks for each role's password once, without
   showing it: first `first_twenty`, then `first_twenty_owner`.

   ```bash
   sudo -u postgres psql -v ON_ERROR_STOP=1 < ~/postgres-setup.sql
   ```

   If your Postgres runs in Docker, copy the file into the container and run it there with a terminal
   (`-it`), so the password prompts read from your keyboard rather than from the script:

   ```bash
   docker cp ~/postgres-setup.sql <container>:/tmp/postgres-setup.sql
   docker exec -it <container> psql -U postgres -v ON_ERROR_STOP=1 -f /tmp/postgres-setup.sql
   ```

4. Check that Postgres listens on localhost only:

   ```bash
   sudo -u postgres psql -tAc 'SHOW listen_addresses'
   ```

   It should print `localhost` (or `127.0.0.1`). If it prints `*`, set `listen_addresses = 'localhost'` in
   `postgresql.conf` (find it with `sudo -u postgres psql -tAc 'SHOW config_file'`) and restart Postgres
   with `sudo systemctl restart postgresql`. A restart briefly disconnects anything else using it.

   **Docker:** leave `listen_addresses` at `*` inside the container (that is the container's own network,
   and `localhost` there would make Postgres unreachable through the published port). What keeps it
   private is publishing the port on the instance's loopback only: `-p 127.0.0.1:5432:5432` (in Compose,
   `"127.0.0.1:5432:5432"`). Check with `sudo ss -ltnp | grep 5432`: it must show `127.0.0.1:5432`, not
   `0.0.0.0:5432`.

5. Allow password logins for the two roles from localhost, to their own database only. Find the file with
   `sudo -u postgres psql -tAc 'SHOW hba_file'`, open it with `sudo nano <that path>`, and add these four
   lines **above** any other `host` lines (the first matching line wins):

   ```
   host    first_twenty  first_twenty,first_twenty_owner  127.0.0.1/32   scram-sha-256
   host    first_twenty  first_twenty,first_twenty_owner  ::1/128        scram-sha-256
   host    all           first_twenty,first_twenty_owner  127.0.0.1/32   reject
   host    all           first_twenty,first_twenty_owner  ::1/128        reject
   ```

   Then reload Postgres (no disconnects): `sudo systemctl reload postgresql`.
   Amazon Linux ships `ident` on its default `host` lines, which rejects passwords; your lines above
   them take care of that. The two `reject` lines keep both roles out of every other database on the
   instance: Postgres lets any role connect to a database unless told otherwise, so without them a
   compromised server could read whatever those databases share with everyone. Other logins are not
   affected. An existing setup can add the two `reject` lines below its `first_twenty` lines at any time.

   **Docker:** skip this step. Connections reach the container from the Docker bridge, not from
   127.0.0.1, so these lines would never match; the official image's own `host all all all scram-sha-256`
   line already accepts both roles' passwords.

6. Test both logins. Each asks for that role's password:

   ```bash
   psql "postgres://first_twenty@127.0.0.1:5432/first_twenty" -c 'SELECT current_user'
   psql "postgres://first_twenty_owner@127.0.0.1:5432/first_twenty" -c 'SELECT current_user'
   ```

   They should print `first_twenty` and `first_twenty_owner`. If not, see
   [Password authentication failed](#password-authentication-failed). With Postgres in Docker, install
   the Postgres client on the instance first; the nightly backups need it too, in the same major version
   as the server or newer (see [What runs every night](#what-runs-every-night)).

## Step 2: copy the code and run the setup script

Put the code in your home folder on the instance, then let the setup script install everything and copy
the code to `/opt/first-twenty`.

**Option A: from a private Git repository** (recommended; updates become one command). On the instance,
install git, make a read-only deploy key and add it to the repository:

```bash
sudo dnf install -y git                      # Ubuntu: sudo apt-get install -y git
ssh-keygen -t ed25519 -f ~/.ssh/first_twenty_deploy -N "" -C "first-twenty deploy key"
cat ~/.ssh/first_twenty_deploy.pub
```

Copy the line it prints. On GitHub open the repository, then Settings > Deploy keys > Add deploy key,
paste it and leave "Allow write access" off. Back on the instance:

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/first_twenty_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
chmod 600 ~/.ssh/config
git clone git@github.com:your-company/first-twenty.git ~/first-twenty
```

The first time, ssh asks whether to trust github.com; type `yes`.

**Option B: copy it from your computer** (no Git hosting needed). On your computer:

```bash
git archive --format=tar.gz -o first-twenty.tgz HEAD
scp -i your-key.pem first-twenty.tgz ec2-user@hr.example.com:~
```

Then on the instance:

```bash
mkdir -p ~/first-twenty && tar -xzf ~/first-twenty.tgz -C ~/first-twenty
```

(`git archive` packs committed files only; commit first.)

**Run the setup script** with your domain, and optionally an email for certificate notices:

```bash
sudo bash ~/first-twenty/server/deploy/setup-ec2.sh --domain hr.example.com --email you@example.com
```

On an instance with under 2 GB of memory (a t3.micro has about 900 MB), setup adds a 2 GB swap file at
`/swapfile`, so `npm ci` and the build fit. The swap file sits on the same disk as Postgres and every
database on it, so setup first checks that the disk keeps 1 GB free on top of the swap file, and skips it
with a warning when it would not (a 20 GB disk with 17 GB free has plenty of room). If making it fails
part way, setup removes the unfinished file. `--swap 1G` picks another size, and `--no-swap` skips it.

On a brand-new instance with no Postgres yet, `--install-postgres` installs it from the OS packages (then
go back to step 1). The script never installs, upgrades or reconfigures a Postgres that already exists,
and never creates, changes or drops a database or role. It only looks whether the `first_twenty`
database and its two roles exist, and says so (then skip step 1).

It prints each step as it goes and finishes with the remaining steps. Here is what it leaves behind:

| Where | What |
|---|---|
| `/opt/first-twenty` | The code (with `.git` when you cloned, so `git pull` works there). Owned by your login; the service can read it but not change it. |
| `/etc/first-twenty/env` | The server's settings, readable only by root. Created from `.env.example` once and never overwritten. |
| `/etc/systemd/system/first-twenty.service` | The service, enabled to start on boot. It runs as the `firsttwenty` system user, which cannot log in. |
| `/etc/caddy/Caddyfile` | Your site: https, `http://` redirected to it, and read timeouts so a client that sends a request a byte at a time cannot hold connections open (3 minutes for a whole upload, 15 seconds for the headers). A Caddyfile you wrote yourself is left alone; the site goes in `/etc/caddy/first-twenty.caddy` and the script tells you the one `import` line to add, and to copy the timeouts (the global options block) to the top of yours. |
| `/etc/apt/apt.conf.d/51first-twenty` | Ubuntu only: automatic Node.js updates and reboots (see [Keep it patched](#keep-it-patched)). Written once and never overwritten. |
| `/usr/local/sbin/first-twenty-backup` and the `first-twenty-backup.timer` | The nightly backup. |

Then delete the copy in your home folder, so the only code on the instance is the code the service runs:

```bash
rm -rf ~/first-twenty ~/first-twenty.tgz
```

From now on you work in `/opt/first-twenty`. `deploy.sh` refuses to run from any other folder.

## Step 3: fill in the settings file

```bash
sudo nano /etc/first-twenty/env
```

Replace `CHANGE_ME` in the two connection lines with the passwords from step 1: the `first_twenty`
password in `DATABASE_URL`, the `first_twenty_owner` password in `MIGRATION_DATABASE_URL`:

```
DATABASE_URL=postgres://first_twenty:server-role-password@127.0.0.1:5432/first_twenty
MIGRATION_DATABASE_URL=postgres://first_twenty_owner:owner-role-password@127.0.0.1:5432/first_twenty
```

Check that `PUBLIC_ORIGIN` is `https://` plus your domain. Setup sets it when it creates the file; when
you re-run setup with another domain it keeps the file, warns, and prints the one command that sets it.
Leave everything else as it is; each line has a comment saying what it does. (The comment near the top
of the file mentions `CHANGE_ME` as an example; that one stays.) Save with Ctrl+O, Enter, Ctrl+X.

If your password has characters other than letters and digits, percent-encode them in the URL: `@` is
`%40`, `:` is `%3A`, `/` is `%2F`, `#` is `%23`, `%` is `%25`.

The file is readable only by root because it holds the database passwords. systemd reads it when it
starts the service and passes everything except `MIGRATION_DATABASE_URL` to the server; `with-env.sh`
reads it (through sudo) when you run a command that needs it.

### If your database and roles already exist

When `postgres-setup.sql` already ran on this instance (setup prints "The first_twenty database and its
two roles already exist"), skip step 1. Setup left the database, both roles and every other database on
the instance exactly as they were. If you are not sure the `pg_hba.conf` lines from step 1.5 are in
place, check them; the rest of step 1 is done.

Give both roles new passwords now, made and set on the instance, so the only copy of each is in
`/etc/first-twenty/env` and a password that was ever made or pasted on another computer stops working.
For each role in turn:

1. Make a password and leave it on screen:

   ```bash
   openssl rand -base64 33 | tr -d '/+=\n'; echo
   ```

2. Set it. psql asks for it twice without showing it, and sends Postgres only a hash, so the password
   is not in your shell history or the Postgres log:

   ```bash
   sudo -u postgres psql -c '\password first_twenty'
   ```

3. Put it in `DATABASE_URL` in place of `CHANGE_ME` (or the old password) with
   `sudo nano /etc/first-twenty/env`.

Then do the same for the owner, `sudo -u postgres psql -c '\password first_twenty_owner'`, and put
that password in `MIGRATION_DATABASE_URL`. When both are in, run `clear` so they leave the screen, and
do not paste them anywhere else. If one is ever lost, set a new one the same way.

Check both after the build in step 4:

```bash
bash server/deploy/with-env.sh npm run server:migrate -- --status
sudo systemctl restart first-twenty
curl -s http://127.0.0.1:8787/api/health
```

The first command logs in as `first_twenty_owner` and lists `001_init.sql` and
`002_history_and_seq_versions.sql` as applied (anything newer shows as pending until `server:migrate`
runs). The health check logs in as `first_twenty` and should say `"db":"up"`. Restart the service
whenever you change `DATABASE_URL`: a running server keeps using its old connections until then. If the
tables turn out to belong to another role (`sudo -u postgres psql first_twenty -c '\dt'` shows the
owner), see [Migrations](#migrations).

## Step 4: build, create the tables and your admin login

Run these as your normal login (not with sudo), in `/opt/first-twenty`:

```bash
cd /opt/first-twenty
npm ci
npm run build:all
bash server/deploy/with-env.sh npm run server:migrate
bash server/deploy/with-env.sh npm run server:create-admin -- --email you@company.com
```

- `npm ci` installs the exact dependencies from `package-lock.json`.
- `npm run build:all` builds the one-file app (`first-twenty.html`) and the server (`dist-server/`).
  It takes a few minutes.
- `server:migrate` creates the tables, as `first_twenty_owner` (`with-env.sh` swaps in
  `MIGRATION_DATABASE_URL` for this command only). It is safe to run any time; it only applies what is
  missing.
- `server:create-admin` asks for the admin password twice, without showing it. Use a password manager to
  make a long one. Running it again later changes the email or password and signs out every session.
- **Pick a login email that is published nowhere**, for example `ops-7k2q@yourcompany.com` instead of
  your address from the company website. The server never sends mail to it, so it only has to look like
  an email address. Anyone who knows the login email can use up its 100 failed sign-ins per 15 minutes
  from a handful of addresses, and then every browser that has not signed in before is refused (see
  [Sign-in says rate_limited everywhere](#sign-in-says-rate_limited-everywhere)).

## Step 5: start the server and check it

```bash
sudo systemctl restart first-twenty
sudo systemctl status first-twenty --no-pager
curl -s http://127.0.0.1:8787/api/health
curl -s https://hr.example.com/api/health
```

Both `curl` lines should print something like `{"ok":true,"db":"up","version":"0.1.0"}`. The first
HTTPS request can take a few seconds while Caddy gets the certificate. If the first works and the second
does not, see [The site does not load over HTTPS](#the-site-does-not-load-over-https).

## Step 6: open the app and upload your workspace

Open `https://hr.example.com`. The server serves the same app you already use.

Your current data is still in the browser where you have been using First Twenty (the double-clicked
`first-twenty.html` file, or `npm run dev`). Each address keeps its own browser storage, so the new
address starts out with the sample company. To move your data across:

1. In the place you have been using, open **Settings > Data** and download a backup.
2. At `https://hr.example.com`, open **Settings > Server**, sign in with the admin email and password,
   and choose **Import a backup** (it opens **Settings > Data**; pick the file you downloaded). After the
   import the app comes back to **Settings > Server**.
3. Choose **Upload this browser's workspace**.

**Keep me signed in on this device** (off by default) decides how long the sign-in lasts: off, the session
ends when the browser closes and after 12 hours at most; on, it lasts up to `SESSION_MAX_DAYS` (7 days).
Either way it ends after 12 hours unused. On a shared computer, finish with **Sign out and remove data**.

From then on every change syncs, and the header shows a sync status (Synced, Syncing, Offline, Signed
out, Needs attention or Paused) that links to **Settings > Server**. On another computer, open the same
address, sign in from **Settings > Server** and choose **Use the server's copy**. The sample company never
syncs, so nothing fictional ends up in your database.

Opened from the `first-twenty.html` file or as a claude.ai artifact, **Settings > Server** only explains
the server: syncing works when the app is opened from your First Twenty server's address.

## Updating

When there is new code, run on the instance:

```bash
cd /opt/first-twenty
bash server/deploy/deploy.sh
```

It pulls the latest commits, runs `npm ci`, builds, and asks the database which migrations it does not
have yet. When there are any, it first takes a backup with the nightly backup service
(`sudo systemctl start first-twenty-backup`, which waits until the dump is written) and prints the
dump's file name; if the backup fails it stops before changing anything. When the dump was written and
checked but a later step failed (the copy to S3, with `BACKUP_S3_URI` set), it goes on with that local
dump and warns, pointing to `sudo journalctl -u first-twenty-backup`. Then it applies the migrations,
restarts the service and checks `/api/health` locally and through Caddy. If any step fails it stops
there, and the running server keeps the version it already loaded. It checks Caddy only when
`PUBLIC_ORIGIN` is an `https://` address, and warns when it is not (still the placeholder, or
`http://localhost:8787` from testing through an SSH tunnel).

`deploy.sh` refuses to run from any other folder than the one the service runs its code from
(`/opt/first-twenty`). Run from an old copy such as `~/first-twenty`, it would migrate the database and
then restart the service on the code it still has.

`--skip-backup` migrates without the fresh backup. Use it only when you have just taken one yourself,
for example on a setup made with `--no-backups`.

Without Git hosting, copy a fresh archive and point the script at it (on your computer):

```bash
git archive --format=tar.gz -o first-twenty.tgz HEAD
scp -i your-key.pem first-twenty.tgz ec2-user@hr.example.com:~
ssh -i your-key.pem ec2-user@hr.example.com "cd /opt/first-twenty && bash server/deploy/deploy.sh --archive ~/first-twenty.tgz"
```

When the new server does not report healthy, `deploy.sh` prints the way back:

- **No migration ran:** `git checkout <previous commit>` and `bash server/deploy/deploy.sh --no-pull`,
  with the commit it started from filled in. The database needs no restore.
- **Migrations ran:** migrations only move forward, so the previous code may not work with the changed
  database. The script prints every command with the commit and the file name of the backup it took just
  before migrating filled in: stop the server, check out and build the previous commit, then restore that
  dump as in [Restore a backup](#restore-a-backup), steps 3 to 6. The backup was taken right before the
  migration, so it misses at most the edits made in the few seconds the migration took.

To go back later, after a release that seemed fine, find the dump from just before the update with
`sudo ls -lh /var/backups/first-twenty` (it is named by the time `deploy.sh` ran, in UTC) and follow the
same steps. Edits made since that dump are not in it; see [Restore a backup](#restore-a-backup) for what
happens to them.

That checkout leaves Git on a fixed commit rather than a branch, so a plain `deploy.sh` cannot pull
until you go back to the branch. When the fix is ready, run:

```bash
cd /opt/first-twenty
git switch main          # or the branch you deploy from
bash server/deploy/deploy.sh
```

(`deploy.sh` notices a rolled-back checkout and prints this instead of a confusing `git pull` error.)

After editing `/etc/first-twenty/env`, apply it with `sudo systemctl restart first-twenty`.

When an update changes `server/deploy/first-twenty.service`, `deploy.sh` warns that the installed unit
differs. Apply it by running setup again (`sudo bash server/deploy/setup-ec2.sh hr.example.com`; it only
changes what differs and never touches your settings file or Postgres). The same goes for an update to
`server/deploy/Caddyfile`: setup rewrites `/etc/caddy/Caddyfile` from it and reloads Caddy.

## Keep it patched

The server faces the internet, so its software needs updates, and some of them do not arrive on their own.

**What is automatic (Ubuntu).** `unattended-upgrades` installs Ubuntu's security updates every day.
Setup adds `/etc/apt/apt.conf.d/51first-twenty`, so it also installs Node.js updates from NodeSource
(which it skips otherwise) and reboots at 04:30, after the nightly backup, when an update needs a reboot
(a new kernel, for example). Postgres, the server and Caddy start again on their own. Setup writes that
file only when it is missing, so edit it freely, for example `Automatic-Reboot "false"` to reboot
yourself. Ubuntu 24.04's `needrestart` restarts the server after a Node.js update; check with
`systemctl show -p ExecMainStartTimestamp first-twenty` that it restarted after the last one, or run
`sudo systemctl restart first-twenty`. Caddy depends on where setup got it (`caddy version` and `apt-cache policy caddy` tell you):

- From Caddy's own apt repository, it updates with the rest.
- From the Caddy release package (setup's fallback when that repository refuses downloads, pinned by
  `CADDY_VERSION` at the top of `setup-ec2.sh`), it never updates on its own. Look at
  [Caddy's security advisories](https://github.com/caddyserver/caddy/security/advisories) once a month;
  to update, raise `CADDY_VERSION` (pick a release at least two weeks old) and run setup again. It checks
  the package against the release's SHA-512 checksums and replaces the older Caddy, keeping your
  Caddyfile.
- Ubuntu's own `caddy` package (the last resort; 2.6 on 24.04, in `universe`) misses years of Caddy fixes.
  Run setup again once GitHub is reachable: it replaces any Caddy older than `CADDY_VERSION`.

**Amazon Linux 2023** installs nothing on its own: run `sudo dnf upgrade` monthly, and reboot when it
updated the kernel.

**Once a month**, on the instance:

```bash
sudo apt-get update && sudo apt-get upgrade        # Amazon Linux: sudo dnf upgrade
ls /var/run/reboot-required 2>/dev/null && sudo reboot
systemctl is-active first-twenty postgresql caddy  # after a reboot: all three say active
caddy version                                      # compare with Caddy's security advisories
```

**Before each update of the code**, on your computer: `npm audit --omit=dev`. `deploy.sh` installs with
`--no-audit`, so this is the only place dependency advisories (fastify, pg and the rest) show up. A fix
reaches the server through a commit and `deploy.sh`.

**Node.js 22 reaches end of life on 2027-04-30.** Move to Node.js 24 (supported until 2028-04-30) before
then: run the build and the full test suite on 24 on your computer, change `NODE_MAJOR=${NODE_MAJOR:-22}`
at the top of `setup-ec2.sh` to 24, then on the instance run setup again (it switches the NodeSource
repository when the installed Node.js is older) and `deploy.sh --no-pull`.

## Two database roles

The server's own login, `first_twenty`, can read and write rows but cannot create, change or drop
tables, create functions or schemas, or empty a table with `TRUNCATE`. If the server process were ever
compromised, the damage stays limited to the rows themselves (which nightly backups cover), and the
schema stays intact. The tables belong to `first_twenty_owner`, whose password lives only in
`MIGRATION_DATABASE_URL`:

| Command | Runs as |
|---|---|
| The server (`systemctl start first-twenty`) | `first_twenty` (`DATABASE_URL`). The systemd unit removes `MIGRATION_DATABASE_URL` from its environment. |
| `with-env.sh npm run server:migrate`, also run by `deploy.sh` (with `-- --status` first) | `first_twenty_owner` |
| `with-env.sh npm run server:after-restore` | `first_twenty_owner` (it moves the change-log counter) |
| `with-env.sh npm run server:create-admin` | `first_twenty` |
| The nightly backup, and the one `deploy.sh` takes before migrating | `first_twenty_owner` when `MIGRATION_DATABASE_URL` is filled in, else `first_twenty` |

Because the server's role cannot change tables, keep `MIGRATE_ON_START=false`; migrations always run
through `with-env.sh` or `deploy.sh`. New tables a migration creates are readable and writable by the
server's role automatically (`postgres-setup.sql` sets default privileges for that).

### Upgrading a setup that has one role

Setups made with an earlier version of this kit have only `first_twenty`, which owns the tables. To
split it:

1. Re-run `postgres-setup.sql` as in step 1. It asks only for the new `first_twenty_owner` password, hands
   the existing tables to `first_twenty_owner`, gives `first_twenty` read and write access to them, and
   takes away its right to create tables. Nothing else changes, and no data moves.

   ```bash
   cd /opt/first-twenty
   sudo -u postgres psql -v ON_ERROR_STOP=1 < server/deploy/postgres-setup.sql
   ```

2. In `pg_hba.conf`, change the user column of your two `first_twenty` lines to
   `first_twenty,first_twenty_owner` (step 1.5), then `sudo systemctl reload postgresql`.
3. Add the line `MIGRATION_DATABASE_URL=postgres://first_twenty_owner:owner-role-password@127.0.0.1:5432/first_twenty`
   to `/etc/first-twenty/env` (`sudo nano /etc/first-twenty/env`).
4. Install the updated systemd unit, which hides that line from the server:
   `sudo bash server/deploy/setup-ec2.sh hr.example.com`.
5. Check: `bash server/deploy/with-env.sh npm run server:migrate -- --status` should say it runs as the
   schema owner and list every migration as applied.

Until step 3 is done, `with-env.sh` runs migrations as `first_twenty` and prints a note; after step 1
that fails with `permission denied for schema public`, so do steps 1 and 3 together.

## Backups and restore

### What runs every night

At 03:15 server time (EC2 instances use UTC unless you changed it), `first-twenty-backup` runs `pg_dump`
and writes `/var/backups/first-twenty/first-twenty-YYYYMMDD-HHMMSSZ.dump` (compressed Postgres custom
format, readable only by root). It checks each new dump, then deletes dumps older than 14 days. Old
dumps are removed only after a new one succeeds. `deploy.sh` runs the same service right before it
applies migrations, so an update that changes the database always has a dump from just before.

```bash
systemctl list-timers first-twenty-backup.timer     # when it ran last and runs next
systemctl status first-twenty-backup --no-pager     # "failed" means the last run failed
sudo journalctl -u first-twenty-backup -n 20        # what the last run said
sudo ls -lh /var/backups/first-twenty               # the dumps
sudo systemctl start first-twenty-backup            # take one now
```

Nothing emails you when a backup fails, so check now and then that the newest dump is from last night.
Change the defaults with `BACKUP_DIR` and `BACKUP_KEEP_DAYS` in `/etc/first-twenty/env`.

**pg_dump must be the same major version as your Postgres server, or newer.** An older one stops with
`aborting because of server version mismatch`, every night. When Postgres runs from the instance's own
packages the matching client is already installed. When it runs in Docker (or you upgrade the server),
install the client for that version: find it with `SHOW server_version`, then on Amazon Linux
`sudo dnf install postgresql17` (for 17) and on Ubuntu `sudo apt-get install postgresql-client-17` (from [apt.postgresql.org](https://wiki.postgresql.org/wiki/Apt)
when your Ubuntu release does not have that version). The backup script checks this before it starts and
prints the right package name for your server when the client is missing or too old. To use a client
installed elsewhere, set `PG_DUMP` and `PG_RESTORE` in `/etc/first-twenty/env`.

### Keep a copy off the instance

A dump on the same disk does not survive losing the instance. Add one or both of these:

- **S3.** Create a private bucket (Block Public Access on, default encryption on). Give the instance an
  IAM role that allows `s3:PutObject` on `arn:aws:s3:::your-bucket-name/first-twenty/*` (EC2 console:
  Actions > Security > Modify IAM role). Amazon Linux has the `aws` command already; on Ubuntu install it
  with `sudo snap install aws-cli --classic`. Then set
  `BACKUP_S3_URI=s3://your-bucket-name/first-twenty/` in `/etc/first-twenty/env`. Never put access keys on
  the instance; the role is enough. Add a lifecycle rule on the bucket to expire old copies, for example
  after 90 days. The role can add copies but not list or read them, so someone who breaks into the
  instance cannot read your old dumps from the bucket. You restore a copy from your own computer
  instead (see [Restore a backup](#restore-a-backup)).
- **EBS snapshots** of the whole disk with Amazon Data Lifecycle Manager (EC2 console > Lifecycle Manager).

The app's own backup download (**Settings > Data**) is a third, independent copy you can keep anywhere.

### Prefer cron

Run setup with `--no-backups`, then follow the cron lines at the top of `server/deploy/backup.sh`.
Amazon Linux 2023 has no cron until you install `cronie`.

### Restore a backup

This keeps your current database under another name, so nothing is lost if you pick the wrong file.

```bash
# 1. Pick the dump to restore.
sudo ls -lh /var/backups/first-twenty

# 2. Stop the server so nothing writes during the restore.
sudo systemctl stop first-twenty

# 3. Set the current database aside.
sudo -u postgres psql -c 'ALTER DATABASE first_twenty RENAME TO first_twenty_before_restore'

# 4. Create a fresh, empty first_twenty database with the same permissions (no password prompt this time).
cd /opt/first-twenty
sudo -u postgres psql -v ON_ERROR_STOP=1 < server/deploy/postgres-setup.sql

# 5. Load the dump, owned by first_twenty_owner (the server's role gets read and write access to the
#    restored tables automatically). Replace the file name with yours.
sudo install -m 600 -o postgres -g postgres /var/backups/first-twenty/first-twenty-20261010-031500Z.dump /var/tmp/ft-restore.dump
sudo -u postgres pg_restore --dbname=first_twenty --no-owner --no-acl --role=first_twenty_owner \
  --single-transaction --exit-on-error /var/tmp/ft-restore.dump
sudo rm /var/tmp/ft-restore.dump

# 6. Bring the schema up to date (in case the dump is older than the code), start a new sync history,
#    then start the server and check it.
bash server/deploy/with-env.sh npm run server:migrate
bash server/deploy/with-env.sh npm run server:after-restore
sudo systemctl start first-twenty
curl -s https://hr.example.com/api/health
```

Do not skip `server:after-restore`. The restored database reuses change numbers that browsers already saw
after the backup was taken; without this step a browser that synced in between would skip the restored
server's new changes and could later overwrite them. The step makes every browser reload the server's
copy, and it signs everyone out and forgets every trusted device (the backup may hold sign-ins and
devices that had already ended). The admin password
is the one in use when the backup was taken; run `server:create-admin` again if you had changed it since.

Both step 6 commands run as `first_twenty_owner` through `with-env.sh`; `server:after-restore` needs it
because it moves the change-log counter, which the server's own role may not do.

**Postgres in Docker:** in steps 3 and 4 use `docker exec -i <container> psql -U postgres ...` in place of
`sudo -u postgres psql ...` (no password prompts come up in step 4, so `-i` with `<` is fine there). For
step 5, copy the dump in and restore it inside the container:
`docker cp /var/backups/first-twenty/<file>.dump <container>:/tmp/ft-restore.dump`, then
`docker exec <container> pg_restore -U postgres --dbname=first_twenty --no-owner --no-acl --role=first_twenty_owner --single-transaction --exit-on-error /tmp/ft-restore.dump`
and `docker exec <container> rm /tmp/ft-restore.dump`.

If the rename says the database is being accessed by other users, something else still holds a connection;
close it, or run
`sudo -u postgres psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'first_twenty'"`
and try again.

**From S3.** The instance's role can only add files to the bucket, so download the dump on your
computer with your own AWS sign-in (the S3 console, or the `aws` command after `aws configure`) and copy
it to the instance. On your computer:

```bash
aws s3 ls s3://your-bucket-name/first-twenty/
aws s3 cp s3://your-bucket-name/first-twenty/<file>.dump .
scp -i your-key.pem <file>.dump ec2-user@hr.example.com:~
```

On the instance, move it into the root-only backups folder, then restore it with the steps above:

```bash
sudo install -m 600 -o root -g root ~/<file>.dump /var/backups/first-twenty/<file>.dump && rm ~/<file>.dump
```

The dump holds your HR data, so delete the copy on your computer when you are done. The other way is to
let the instance read the bucket: add `s3:GetObject` on `arn:aws:s3:::your-bucket-name/first-twenty/*`
and `s3:ListBucket` on `arn:aws:s3:::your-bucket-name` (with an `s3:prefix` condition of
`first-twenty/`) to its role, and `sudo aws s3 cp` then works on the instance. The trade-off: anyone who
gets root on the instance can then read every old dump in the bucket, including data you have deleted
since, which is why the write-only role is the recommended setup.

Changes made after the backup was taken are not in it. After `server:after-restore`, each browser that
was connected reloads the server's copy on its next sync and drops what the restored copy does not have.
An edit still waiting in a browser's queue is sent again: it applies when the record has not changed on
the server since that browser last saw it, and otherwise the server's copy wins and the browser says how
many items it refreshed. If a browser holds recent work you want to keep, download a backup from it
(**Settings > Data**) while the server is still stopped, before step 6, so you can look those changes up
and enter them again.

When everything looks right, remove the set-aside copy:
`sudo -u postgres dropdb first_twenty_before_restore`.

## Develop locally

### With PGlite (no Postgres needed)

PGlite is real Postgres compiled to WebAssembly. With no `.env` file the server uses it automatically and
keeps the data in `.data/pg` in the project folder.

```bash
npm run server:create-admin -- --email you@example.com     # once, for a local login
npm run server:dev                                         # the API on http://127.0.0.1:8787
npm run dev                                                # in a second terminal: the app on http://127.0.0.1:8826
```

The Vite dev server passes `/api` through to the local server, so the app and the API share one address,
just like on EC2. Only one process can open the PGlite folder at a time, so stop `server:dev` before
running `server:migrate` or `server:create-admin`. Delete `.data/` to start over.

### Against the EC2 database, through an SSH tunnel

Postgres stays closed to the internet; the tunnel carries the connection inside SSH. On your computer,
in its own terminal window (leave it open):

```bash
ssh -i your-key.pem -N -L 5433:localhost:5432 ec2-user@hr.example.com
```

Then create `.env` in the project folder (it is git-ignored) with:

```
DATABASE_URL=postgres://first_twenty:your-password-here@127.0.0.1:5433/first_twenty
PGSSLMODE=disable
```

and run `npm run server:dev` and `npm run dev` as above. Port 5433 avoids clashing with a Postgres on your
own computer.

This is your live company data: anything you change locally is real. Use the server's role
(`first_twenty`) here, never the owner: then `npm run server:migrate` from your computer stops with
`permission denied for schema public` instead of changing the production schema, and schema changes
reach production only through `deploy.sh`. Use PGlite for experiments, and delete `.env` (or comment out
the line) when you are done.

## Troubleshooting

Logs first, every time:

```bash
sudo journalctl -u first-twenty -n 50 --no-pager     # the server
sudo journalctl -u caddy -n 50 --no-pager            # HTTPS and the proxy
sudo journalctl -u postgresql -n 50 --no-pager       # Postgres (the unit name can differ on Ubuntu)
```

### 502 Bad Gateway from Caddy

Caddy is up but the server is not answering on `127.0.0.1:8787`.

- `sudo systemctl status first-twenty`. If it is restarting over and over, the server log says why.
  systemd never stops restarting it (5 seconds apart), so it comes back on its own once the cause is gone.
  It prints plain messages for bad settings, for example `DATABASE_URL still contains the CHANGE_ME
  placeholder` (step 3) or `SERVE_APP=true but the app file ... does not exist` (run `npm run build:all`).
- `curl -s http://127.0.0.1:8787/api/health` on the instance. If this works, compare `PORT` in
  `/etc/first-twenty/env` with the `reverse_proxy` line in `/etc/caddy/Caddyfile`.
- A 502 for a few seconds during `deploy.sh` is normal while the service restarts.
- Meanwhile a browser that opened the app from this address before still opens it (the offline worker's
  copy of the page, `/sw.js`) and shows Offline; its changes wait there and sync once the server answers.

### The site does not load over HTTPS

- DNS: `nslookup hr.example.com` must show the Elastic IP. Setup also warns when it does not.
- Security group: ports 80 and 443 open to anywhere (port 80 is needed for the certificate).
- The Caddy log says what the certificate authority answered. After several failures Caddy waits before
  retrying; fix the cause and run `sudo systemctl reload caddy`.

### Password authentication failed

The server log shows `password authentication failed for user "first_twenty"` or similar (or
`"first_twenty_owner"` when `server:migrate` or `deploy.sh` fails).

- The password in `DATABASE_URL` (or `MIGRATION_DATABASE_URL`) is wrong or needs percent-encoding
  (step 3). Set a new one with `sudo -u postgres psql -c '\password first_twenty'` (or
  `first_twenty_owner`), update the file, and for `DATABASE_URL` restart the service.
- `Ident authentication failed` or `no pg_hba.conf entry`: the two lines from step 1 are missing, sit
  below a broader `host` line, or name only `first_twenty` in the user column. Fix them and reload
  Postgres.
- The password was saved before `password_encryption` was `scram-sha-256` (older setups use `md5`).
  Check with `sudo -u postgres psql -tAc 'SHOW password_encryption'`; set it to `scram-sha-256` in
  `postgresql.conf`, reload, and set the password again with `\password`.
- `connection refused`: Postgres is not running or not on port 5432. Check with
  `sudo ss -ltnp | grep 5432`.

### Migrations

- See what is applied and what is pending:
  `bash server/deploy/with-env.sh npm run server:migrate -- --status`
- Each migration file runs in its own transaction, so a failure leaves nothing half done. Fix the cause
  in the message and run `server:migrate` again.
- `permission denied for schema public`: the migration ran as the server's role. Check that
  `MIGRATION_DATABASE_URL` is in `/etc/first-twenty/env` and that `with-env.sh` says `Running
  server:migrate as the schema owner`. If it does and the error stays, the grants from
  `postgres-setup.sql` are missing: run step 1 again; it is safe.
- `must be owner of table ...`: the tables were created by another role (for example by running
  migrations as `postgres`). Re-running `postgres-setup.sql` fixes tables owned by `first_twenty`; for
  any other owner, hand them over as the superuser:

  ```bash
  sudo -u postgres psql first_twenty -c "SELECT format('ALTER TABLE %I OWNER TO first_twenty_owner;', tablename) FROM pg_tables WHERE schemaname = 'public'" -tA | sudo -u postgres psql first_twenty
  sudo -u postgres psql first_twenty -c 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO first_twenty; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO first_twenty'
  ```
- `MIGRATION_DATABASE_URL ... still has the CHANGE_ME placeholder`: put the `first_twenty_owner`
  password in it (step 3).

### The server cannot reach a database on another host

The systemd unit lets the server talk to `127.0.0.1` and `::1` only (`IPAddressDeny=any` with
`IPAddressAllow=127.0.0.1/32 ::1/128`), so a compromised process cannot open a connection to the
internet, and not even to the DNS resolver on `127.0.0.53`. It can still reach what listens on
`127.0.0.1`: Postgres (the `reject` lines from step 1.5 keep it to its own database) and Caddy's admin
endpoint on port 2019, which can change Caddy's configuration. Nor does the sandbox stop data leaving in
the server's own answers. If `DATABASE_URL` points at another machine (RDS, a second instance),
connections time out until you allow that address. Add it in a drop-in, which survives re-running setup:

```bash
sudo systemctl edit first-twenty
```

and enter, with your database's private IP address or subnet (names are not resolved here):

```
[Service]
IPAddressAllow=10.0.1.23
```

then `sudo systemctl restart first-twenty`. Use `PGSSLMODE=verify-full` for a remote database. The same
applies to Postgres in Docker only when the Docker daemon runs with `"userland-proxy": false`: then add
the Docker network (for example `IPAddressAllow=172.16.0.0/12`).

### Signed in, but signed out again right away (cookie not set over http)

Over https the sign-in cookie is `__Host-ft_session`, marked Secure: always when `PUBLIC_ORIGIN` starts
with `https://`, and for every request that reaches Caddy over https in any case. Browsers never send a
Secure cookie over plain `http://`. Always open `https://hr.example.com`, never the instance's IP address
or `http://`. The cookie is also limited to its own site: a copy of the app opened from a file or from
`localhost` cannot sign in to the server. Open the app from the server's address. (Through an SSH tunnel
to `http://localhost:8787`, Chrome and Firefox accept the Secure cookie too; other browsers may not.)

To see whether the server counts a browser as signed in, open `https://hr.example.com/api/auth/session`
in it: `{"user":{...}}` when it is, `{"user":null}` when it is not. The app asks the same on every page
load; the answer is never a 401, so a browser that is not signed in shows no errors in its console.
(`/api/auth/me` answers 401 instead and stays for older copies of the app.) Signed in, open
`https://hr.example.com/api/workspace/status` to see whether the server holds a workspace yet:
`{"empty":true}` before the first upload, else its history id and change count. The app asks that,
not `/api/workspace` (which answers 404 while the server is empty), so an empty server logs no errors
either.

On an sslip.io name, if every page of the site fails with an error after you opened another
`*.sslip.io` site, clear the site data for `sslip.io` (see
[A free sslip.io name instead](#a-free-sslipio-name-instead)).

### Sign-in says rate_limited everywhere

Someone is guessing passwords for your login email from many addresses: after 100 failures in 15 minutes
the server refuses every sign-in for that email, so that guessing stays far too slow to work. Browsers
you have signed in from before still get in (each keeps a trusted-device cookie for 180 days, which has a
limit of its own), so try one of those first. Restarting the server does not help: the guessing fills the
limit again in seconds. Give the login a new email that is published nowhere instead (step 4); the new
email starts with clean limits, and the old one stops mattering:

```bash
cd /opt/first-twenty
bash server/deploy/with-env.sh npm run server:create-admin -- --email ops-<something-random>@yourcompany.com
```

It asks for a password (the same one is fine), signs out every session and forgets every trusted device,
so sign in again with the new email.

### Clock skew

Sessions expire by the server's clock (12 hours idle, 7 days at most), and certificates are checked
against your computer's clock.

- On the instance, `timedatectl` should say `System clock synchronized: yes`. EC2 instances sync with
  the Amazon Time Sync Service through chrony by default; if it says no, run
  `sudo systemctl enable --now chronyd` (Ubuntu: `chrony`).
- If your browser shows a certificate date error, check your computer's date and time.

### The build runs out of memory

`npm run build:all` stops with `Killed` or `JavaScript heap out of memory`. Check for swap with
`swapon --show`. Setup adds a 2 GB swap file on its own under 2 GB of memory, unless the disk is short
(it warns "Skipped the swap file"): free some space and run setup again, or run it with `--swap 1G`. On a
larger instance that still runs out, run setup again with `--swap 2G` (it only adds what is missing),
then rerun the build.

### The service cannot read its files

If the server log shows `EACCES` for a file under `/opt/first-twenty`, your login's umask made new files
private. Fix them with `sudo chmod -R g+rX /opt/first-twenty`. `deploy.sh` sets a safe umask for itself.

## What is and is not stored

**On the server, in Postgres:**

- Every record in your workspace, one table per kind (people, comp records, equity grants, jobs,
  candidates, applications, interviews, scorecards, offers, time off, checklists, trainings, policies,
  the activity log, and the rest), plus the single documents (company, settings, equity setup, compliance
  status, inbox snoozes).
- A change log of accepted changes, used to sync browsers. The server removes entries older than 120
  days once a day. When a record is deleted, its earlier entries go at once, leaving only a note that
  it was deleted (without its contents); a full replace (Import, Start fresh) removes every earlier
  entry. Older copies stay in the nightly dumps until those age out (14 days by default) and in S3 for as
  long as your bucket's lifecycle rule keeps them.
- The admin login: the email and a scrypt hash of the password, never the password itself.
- Sign-in sessions: a SHA-256 hash of each session token (never the token), with the time, IP address and
  browser name.
- Trusted devices: a SHA-256 hash of each browser's device token and when it expires (180 days after its
  last sign-in). It only lets that browser past the per-email sign-in limit. `server:create-admin` and
  `server:after-restore` forget them all.

**Never stored anywhere:** the things First Twenty does not collect in the first place (SSNs, dates of
birth, bank details, home street addresses, ID scans, I-9 forms, background check reports, medical
details, salary history, protected characteristics). Server logs never include request bodies, cookies or
passwords.

**Stays in each browser:** display preferences (look, text size, theme, shortcuts) and the sync queue.
Each signed-in browser also keeps a full copy of the workspace so it works offline, so treat a laptop
that has signed in like any device holding HR data: disk encryption on, sign out on shared computers.
A browser that opened the app from your server's address also keeps a copy of the app page itself (the
offline worker's cache), which holds no workspace data.

**Other copies:** nightly dumps in `/var/backups/first-twenty` (and S3 if you set it up), and Caddy's
access log in `/var/log/caddy` (addresses, paths and browser names; no bodies, and Caddy hides cookies).

## One admin login and the path to team logins

For now the server has exactly one login, and whoever has it can read and change everything. **Viewing
as** in the app is still a preview, not security: it changes what the screen shows, not what the server
allows. So:

- Keep the admin login to yourself (or one trusted operator). Do not give it to managers or employees.
- To change the password, or hand the login to someone else, run `server:create-admin` again (step 4).
  It also signs out every session, which is the quickest way to cut off a lost laptop.
- Anyone with SSH access to the instance can read the database, so keep SSH limited to your IP and your
  key to yourself.

The groundwork for team logins is already in place: the `users` table has a `role` column (`admin`,
`manager`, `employee`), and every change records who made it. Moving to team logins means:

1. One login per person, linked to their person record, with invitations and password resets.
2. The server enforcing the same access rules the app uses today for its preview, on every read and
   write: employees see their own pay and equity only, hiring managers see their own jobs and candidates,
   and pay fields are removed from what non-admins receive.
3. Optionally, single sign-on with your Google Workspace or Microsoft account instead of passwords.

Until then, the single admin login keeps the data in your hands only.
