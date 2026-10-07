const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const env = require('../config/env');
const { AppError } = require('../middleware/errorHandler');

const SALT_ROUNDS = 10;
const TOKEN_TTL = '7d';

function signToken({ id, kind, role }) {
  return jwt.sign({ sub: id, kind, role }, env.jwtSecret, { expiresIn: TOKEN_TTL });
}

function toAccountView(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    avatarUrl: row.avatar_url,
    status: row.status,
  };
}

async function register({ fullName, email, phone, password, role, shopName }) {
  if (!['bidder', 'seller'].includes(role)) {
    throw new AppError('Vai trò đăng ký phải là bidder hoặc seller', 400, 'VALIDATION_ERROR');
  }
  if (!fullName || !email || !password) {
    throw new AppError('Thiếu họ tên, email hoặc mật khẩu', 400, 'VALIDATION_ERROR');
  }

  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let account;
    try {
      const result = await client.query(
        `INSERT INTO accounts (full_name, email, phone, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, full_name, email, phone, avatar_url, status`,
        [fullName.trim(), normalizedEmail, phone || null, passwordHash],
      );
      account = result.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw new AppError('Email này đã được đăng ký', 409, 'EMAIL_TAKEN');
      }
      throw err;
    }

    if (role === 'bidder') {
      await client.query('INSERT INTO bidders (account_id) VALUES ($1)', [account.id]);
    } else {
      await client.query(
        'INSERT INTO sellers (account_id, store_name) VALUES ($1, $2)',
        [account.id, shopName?.trim() || fullName.trim()],
      );
    }

    await client.query('COMMIT');
    const token = signToken({ id: account.id, kind: 'account', role });
    return { account: toAccountView(account), role, token };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function resolveAccountRole(client, accountId) {
  const bidder = await client.query('SELECT 1 FROM bidders WHERE account_id = $1', [accountId]);
  if (bidder.rowCount > 0) return 'bidder';
  const seller = await client.query('SELECT 1 FROM sellers WHERE account_id = $1', [accountId]);
  if (seller.rowCount > 0) return 'seller';
  return null;
}

async function login({ email, password }) {
  if (!email || !password) {
    throw new AppError('Thiếu email hoặc mật khẩu', 400, 'VALIDATION_ERROR');
  }
  const normalizedEmail = email.trim().toLowerCase();

  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT id, full_name, email, phone, avatar_url, status, password_hash
       FROM accounts WHERE lower(email) = $1`,
      [normalizedEmail],
    );
    const account = result.rows[0];
    if (!account) {
      throw new AppError('Email hoặc mật khẩu không đúng', 401, 'INVALID_CREDENTIALS');
    }
    if (account.status !== 'active') {
      throw new AppError('Tài khoản đã bị tạm khoá', 403, 'ACCOUNT_SUSPENDED');
    }
    const ok = await bcrypt.compare(password, account.password_hash);
    if (!ok) {
      throw new AppError('Email hoặc mật khẩu không đúng', 401, 'INVALID_CREDENTIALS');
    }

    const role = await resolveAccountRole(client, account.id);
    if (!role) {
      throw new AppError('Tài khoản chưa gắn với vai trò bidder/seller nào', 500, 'INTERNAL_ERROR');
    }

    const token = signToken({ id: account.id, kind: 'account', role });
    return { account: toAccountView(account), role, token };
  } finally {
    client.release();
  }
}

async function loginOps({ email, password }) {
  if (!email || !password) {
    throw new AppError('Thiếu email hoặc mật khẩu', 400, 'VALIDATION_ERROR');
  }
  const normalizedEmail = email.trim().toLowerCase();

  const result = await pool.query(
    `SELECT id, name, email, role, status, password_hash
     FROM ops_accounts WHERE lower(email) = $1`,
    [normalizedEmail],
  );
  const ops = result.rows[0];
  if (!ops || !ops.password_hash) {
    throw new AppError('Email hoặc mật khẩu không đúng', 401, 'INVALID_CREDENTIALS');
  }
  if (ops.status !== 'active') {
    throw new AppError('Tài khoản đã bị tạm khoá', 403, 'ACCOUNT_SUSPENDED');
  }
  const ok = await bcrypt.compare(password, ops.password_hash);
  if (!ok) {
    throw new AppError('Email hoặc mật khẩu không đúng', 401, 'INVALID_CREDENTIALS');
  }

  const token = signToken({ id: ops.id, kind: 'ops', role: ops.role });
  return {
    account: { id: ops.id, fullName: ops.name, email: ops.email, status: ops.status },
    role: ops.role,
    token,
  };
}

async function getMe(user) {
  if (user.kind === 'ops') {
    const result = await pool.query(
      'SELECT id, name, email, role, status FROM ops_accounts WHERE id = $1',
      [user.id],
    );
    const ops = result.rows[0];
    if (!ops) throw new AppError('Không tìm thấy tài khoản', 404, 'NOT_FOUND');
    return {
      id: ops.id,
      fullName: ops.name,
      email: ops.email,
      role: ops.role,
      status: ops.status,
      kind: 'ops',
    };
  }

  const result = await pool.query(
    'SELECT id, full_name, email, phone, avatar_url, status FROM accounts WHERE id = $1',
    [user.id],
  );
  const account = result.rows[0];
  if (!account) throw new AppError('Không tìm thấy tài khoản', 404, 'NOT_FOUND');
  return { ...toAccountView(account), role: user.role, kind: 'account' };
}

module.exports = { register, login, loginOps, getMe };
