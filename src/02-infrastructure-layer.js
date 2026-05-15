import { existsSync, mkdirSync, readFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import axios from 'axios';

export function createInfrastructure(config) {
  mkdirSync(config.dataDir, { recursive: true });

  const db = new DatabaseSync(config.dbFile);
  initializeDatabase(db);
  migrateLegacyJsonIfNeeded(db, config.legacyJsonDbFile);

  function loadVisitors() {
    const rows = db.prepare(`
      SELECT visitor_name, license_plate, company, phone, reason, visited_at, is_returning, previous_summary
      FROM visitors
      ORDER BY visited_at DESC, id DESC
      LIMIT 200
    `).all();

    return {
      visitors: rows.map((row) => ({
        visitor_name: row.visitor_name || '',
        license_plate: row.license_plate || '',
        company: row.company || '',
        phone: row.phone || '',
        reason: row.reason || '',
        visited_at: row.visited_at || '',
        is_returning: Boolean(row.is_returning),
        previous_summary: row.previous_summary || ''
      }))
    };
  }

  function queryVisitors(filters = {}) {
    const where = [];
    const params = [];
    const limit = Math.min(Number(filters.limit) || 1000, 5000);

    if (filters.startIso) {
      where.push('visited_at >= ?');
      params.push(filters.startIso);
    }
    if (filters.endIso) {
      where.push('visited_at < ?');
      params.push(filters.endIso);
    }
    if (filters.phone) {
      where.push('phone = ?');
      params.push(filters.phone);
    }
    if (filters.licensePlate) {
      where.push('license_plate = ?');
      params.push(filters.licensePlate);
    }
    if (filters.company) {
      where.push('company LIKE ?');
      params.push(`%${filters.company}%`);
    }
    if (filters.visitorName) {
      where.push('visitor_name LIKE ?');
      params.push(`%${filters.visitorName}%`);
    }

    params.push(limit);
    const sql = `
      SELECT visitor_name, license_plate, company, phone, reason, visited_at, is_returning, previous_summary
      FROM visitors
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY visited_at DESC, id DESC
      LIMIT ?
    `;

    return db.prepare(sql).all(...params).map((row) => ({
      visitor_name: row.visitor_name || '',
      license_plate: row.license_plate || '',
      company: row.company || '',
      phone: row.phone || '',
      reason: row.reason || '',
      visited_at: row.visited_at || '',
      is_returning: Boolean(row.is_returning),
      previous_summary: row.previous_summary || ''
    }));
  }

  function listCompanies() {
    return db.prepare(`
      SELECT company
      FROM visitors
      WHERE company <> ''
      GROUP BY company
      ORDER BY COUNT(*) DESC, MAX(visited_at) DESC
      LIMIT 200
    `).all().map((row) => row.company);
  }

  function listVisitorNames() {
    return db.prepare(`
      SELECT visitor_name
      FROM visitors
      WHERE visitor_name <> ''
      GROUP BY visitor_name
      ORDER BY COUNT(*) DESC, MAX(visited_at) DESC
      LIMIT 200
    `).all().map((row) => row.visitor_name);
  }

  async function saveVisit(visitor) {
    db.prepare(`
      INSERT INTO visitors (
        visitor_name, license_plate, company, phone, reason, visited_at, is_returning, previous_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      visitor.visitor_name || '',
      visitor.license_plate || '',
      visitor.company || '',
      visitor.phone || '',
      visitor.reason || '',
      visitor.visited_at || new Date().toISOString(),
      visitor.is_returning ? 1 : 0,
      visitor.previous_summary || ''
    );

    db.prepare(`
      DELETE FROM visitors
      WHERE id NOT IN (
        SELECT id FROM visitors
        ORDER BY visited_at DESC, id DESC
        LIMIT 200
      )
    `).run();
  }

  async function saveRiskEvent(event) {
    db.prepare(`
      INSERT INTO risk_events (
        phone, transcript, risk_type, risk_level, action, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.phone || '',
      event.transcript || '',
      event.risk_type || 'unknown',
      event.risk_level || 'low',
      event.action || 'log',
      event.created_at || new Date().toISOString()
    );
  }

  async function notifyGuard(visitor) {
    const title = '访客登记通知';
    const content = [
      visitor.visitor_name ? `**访客：** ${visitor.visitor_name}` : '',
      `**车牌：** ${visitor.license_plate}`,
      `**来访单位：** ${visitor.company}`,
      `**来访事由：** ${visitor.reason}`,
      `**手机：** ${visitor.phone}`,
      `**入场时间：** ${formatTimestamp(visitor.visited_at)}`,
      visitor.is_returning ? `**回访记录：** ${visitor.previous_summary}` : ''
    ].filter(Boolean).join('\n\n');

    if (!config.pushplusToken) {
      console.log('[个人微信通知模拟] ' + title + '\n' + content);
      return;
    }

    const payload = {
      token: config.pushplusToken,
      title,
      content,
      template: 'markdown'
    };
    if (config.pushplusTopic) payload.topic = config.pushplusTopic;

    const response = await axios.post(config.pushplusSendUrl, payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    if (response.data?.code && response.data.code !== 200) {
      throw new Error(`PushPlus 推送失败：${response.data.msg || response.data.code}`);
    }
  }

  return { loadVisitors, queryVisitors, listCompanies, listVisitorNames, saveVisit, saveRiskEvent, notifyGuard };
}

function initializeDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS visitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_name TEXT NOT NULL DEFAULT '',
      license_plate TEXT NOT NULL,
      company TEXT NOT NULL,
      phone TEXT NOT NULL,
      reason TEXT NOT NULL,
      visited_at TEXT NOT NULL,
      is_returning INTEGER NOT NULL DEFAULT 0,
      previous_summary TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS risk_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL DEFAULT '',
      transcript TEXT NOT NULL DEFAULT '',
      risk_type TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'log',
      created_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, 'visitors', 'visitor_name', "TEXT NOT NULL DEFAULT ''");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_visitors_phone ON visitors (phone);
    CREATE INDEX IF NOT EXISTS idx_visitors_license_plate ON visitors (license_plate);
    CREATE INDEX IF NOT EXISTS idx_visitors_name ON visitors (visitor_name);
    CREATE INDEX IF NOT EXISTS idx_visitors_visited_at ON visitors (visited_at);
    CREATE INDEX IF NOT EXISTS idx_risk_events_phone ON risk_events (phone);
    CREATE INDEX IF NOT EXISTS idx_risk_events_created_at ON risk_events (created_at);
  `);
}

function migrateLegacyJsonIfNeeded(db, legacyJsonDbFile) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM visitors').get().count;
  if (count > 0 || !legacyJsonDbFile || !existsSync(legacyJsonDbFile)) return;

  let legacy;
  try {
    legacy = JSON.parse(readFileSync(legacyJsonDbFile, 'utf8'));
  } catch (error) {
    console.warn('旧 JSON 访客数据读取失败，跳过迁移。', error?.message || error);
    return;
  }

  const visitors = Array.isArray(legacy.visitors) ? legacy.visitors : [];
  const insert = db.prepare(`
    INSERT INTO visitors (
      visitor_name, license_plate, company, phone, reason, visited_at, is_returning, previous_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    for (const visitor of visitors) {
      insert.run(
        visitor.visitor_name || visitor.name || '',
        visitor.license_plate || '',
        visitor.company || '',
        visitor.phone || '',
        visitor.reason || '',
        visitor.visited_at || new Date().toISOString(),
        visitor.is_returning ? 1 : 0,
        visitor.previous_summary || ''
      );
    }
    db.exec('COMMIT');
    console.log(`已从旧 JSON 迁移 ${visitors.length} 条访客记录到 SQLite。`);
  } catch (error) {
    db.exec('ROLLBACK');
    console.warn('旧 JSON 访客数据迁移失败。', error?.message || error);
  }
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function formatTimestamp(ts) {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
