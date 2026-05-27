import sys, hashlib, secrets, json
sys.path.insert(0, 'app/backend')
from utils import get_db

conn = get_db()

# Cek kolom yang ada
cols = {r[1] for r in conn.execute('PRAGMA table_info(users)').fetchall()}
print('Kolom saat ini:', cols)

# Migrasi — tambah kolom yang kurang
if 'nama' not in cols:
    conn.execute("ALTER TABLE users ADD COLUMN nama TEXT NOT NULL DEFAULT ''")
    print('+ kolom nama')
if 'permissions' not in cols:
    conn.execute("ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'")
    print('+ kolom permissions')
if 'aktif' not in cols:
    conn.execute('ALTER TABLE users ADD COLUMN aktif INTEGER NOT NULL DEFAULT 1')
    print('+ kolom aktif')

conn.commit()

# Buat / update user owner
salt = secrets.token_hex(8)
pwd  = hashlib.sha256(f'{salt}admin123'.encode()).hexdigest()
pwd_hash = f'{salt}:{pwd}'

existing = conn.execute("SELECT id FROM users WHERE username='owner'").fetchone()
if existing:
    conn.execute(
        "UPDATE users SET password_hash=?, role='owner', nama='Owner', aktif=1 WHERE username='owner'",
        (pwd_hash,)
    )
    print('User owner di-update')
else:
    conn.execute(
        "INSERT INTO users (network_id, username, nama, password_hash, role, permissions, aktif) VALUES (?,?,?,?,?,?,1)",
        ('net1', 'owner', 'Owner', pwd_hash, 'owner', '[]')
    )
    print('User owner dibuat baru')

conn.commit()

# Verifikasi
row = conn.execute("SELECT id, username, role, aktif FROM users WHERE username='owner'").fetchone()
print('User owner di DB:', tuple(row))
conn.close()
print('')
print('Selesai! Login dengan:')
print('  username : owner')
print('  password : admin123')
# ── Migrasi tabel pelanggan ────────────────────────────────────
print('')
print('=== Migrasi tabel pelanggan ===')
conn = get_db()
cols_p = {r[1] for r in conn.execute('PRAGMA table_info(pelanggan)').fetchall()}
print('Kolom saat ini:', cols_p)

for col, defval in [
    ('nama',  "TEXT DEFAULT ''"),
    ('no_hp', "TEXT DEFAULT ''"),
    ('aktif', 'INTEGER DEFAULT 1'),
]:
    if col not in cols_p:
        conn.execute(f"ALTER TABLE pelanggan ADD COLUMN {col} {defval}")
        print(f'+ kolom {col}')
    else:
        print(f'sudah ada: {col}')

conn.commit()
conn.close()
print('Migrasi pelanggan selesai.')