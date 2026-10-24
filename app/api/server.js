const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const config = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'appdb',
  user:     process.env.DB_USER     || 'appuser',
  password: process.env.DB_PASSWORD || '',
};
const API_PORT = parseInt(process.env.API_PORT || '3000', 10);

const pool = new Pool({ ...config, max: 5, connectionTimeoutMillis: 5000 });

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS taches (
      id      serial PRIMARY KEY,
      titre   text NOT NULL,
      faite   boolean DEFAULT false,
      cree_le timestamptz DEFAULT now()
    );`);
  console.log('Migration OK');
}

app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get('/ready', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ready' }); }
  catch (e) { res.status(503).json({ status: 'not-ready', error: e.message }); }
});

app.get('/api/taches', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM taches ORDER BY id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/taches', async (req, res) => {
  const { titre } = req.body;
  if (!titre) return res.status(400).json({ error: 'titre requis' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO taches (titre) VALUES ($1) RETURNING *', [titre]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/taches/:id', async (req, res) => {
  const { titre, faite } = req.body;
  try {
    const { rows } = await pool.query(
      'UPDATE taches SET titre=COALESCE($1,titre), faite=COALESCE($2,faite) WHERE id=$3 RETURNING *',
      [titre, faite, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'introuvable' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/taches/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM taches WHERE id=$1', [req.params.id]);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

(async () => {
  for (let i = 0; i < 30; i++) {
    try { await migrate(); break; }
    catch (e) {
      console.log(`Base pas prête (${e.message}), retry dans 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  app.listen(API_PORT, () => console.log(`API à l'écoute sur :${API_PORT}`));
})();
