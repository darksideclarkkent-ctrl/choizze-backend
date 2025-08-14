require('dotenv').config();
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

const db = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

async function createTables() {
  const client = await db.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS friends (
          id SERIAL PRIMARY KEY,
          sender_id INT NOT NULL REFERENCES users(id),
          receiver_id INT NOT NULL REFERENCES users(id),
          status VARCHAR(20) DEFAULT 'pending' NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (sender_id, receiver_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          sender_id INT NOT NULL REFERENCES users(id),
          receiver_id INT NOT NULL REFERENCES users(id),
          content TEXT NOT NULL,
          timestamp TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS posts (
          id SERIAL PRIMARY KEY,
          user_id INT NOT NULL REFERENCES users(id),
          content TEXT NOT NULL,
          media_url VARCHAR(255),
          created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS news (
          id SERIAL PRIMARY KEY,
          post_id INT NOT NULL REFERENCES posts(id),
          user_id INT NOT NULL REFERENCES users(id),
          created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS comments (
          id SERIAL PRIMARY KEY,
          post_id INT NOT NULL REFERENCES posts(id),
          user_id INT NOT NULL REFERENCES users(id),
          content TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
          id SERIAL PRIMARY KEY,
          subscriber_id INT NOT NULL REFERENCES users(id),
          target_id INT NOT NULL REFERENCES users(id),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (subscriber_id, target_id)
      );

      CREATE TABLE IF NOT EXISTS reports (
          id SERIAL PRIMARY KEY,
          reporter_id INT NOT NULL REFERENCES users(id),
          report_type VARCHAR(50) NOT NULL,
          entity_id INT NOT NULL,
          reason TEXT NOT NULL,
          status VARCHAR(20) DEFAULT 'open' NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Все таблицы успешно созданы!');
  } catch (err) {
    console.error('Ошибка при создании таблиц', err.stack);
  } finally {
    client.release();
    db.end();
  }
}

createTables();