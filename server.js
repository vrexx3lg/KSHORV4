const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8008;

app.use(bodyParser.json());
app.use(express.static(__dirname));

// ==================== БАЗА ДАННЫХ (PostgreSQL / Supabase) ====================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initializeDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS applications (
            id SERIAL PRIMARY KEY,
            full_name TEXT NOT NULL,
            age INTEGER NOT NULL,
            phone TEXT NOT NULL,
            email TEXT NOT NULL,
            direction TEXT NOT NULL,
            direction_name TEXT NOT NULL,
            message TEXT,
            status TEXT DEFAULT 'new',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await client.query(`CREATE TABLE IF NOT EXISTS customers (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            orders_count INTEGER DEFAULT 0,
            first_order TIMESTAMP,
            last_order TIMESTAMP
        )`);

        await client.query(`CREATE TABLE IF NOT EXISTS admins (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        )`);

        const adminExists = await client.query("SELECT * FROM admins WHERE username = 'admin'");
        if (adminExists.rows.length === 0) {
            const adminPass = process.env.ADMIN_PASSWORD || 'admin2024';
            await client.query("INSERT INTO admins (username, password) VALUES ('admin', $1)", [adminPass]);
            console.log('👑 Создан администратор: admin / ' + adminPass);
        }

        console.log('✅ База данных инициализирована');
    } finally {
        client.release();
    }
}

// ==================== API ====================

// 1. Создать заявку
app.post('/api/applications', async (req, res) => {
    const { fullName, age, phone, email, direction, directionName, message } = req.body;
    if (!fullName || !age || !phone || !email || !direction) {
        return res.status(400).json({ error: 'Заполните все обязательные поля' });
    }
    const createdAt = new Date().toISOString();
    try {
        const result = await pool.query(
            `INSERT INTO applications (full_name, age, phone, email, direction, direction_name, message, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [fullName, age, phone, email, direction, directionName || direction, message || '', createdAt]
        );

        const existing = await pool.query("SELECT * FROM customers WHERE email = $1", [email]);
        if (existing.rows.length > 0) {
            await pool.query("UPDATE customers SET orders_count = orders_count + 1, last_order = $1 WHERE email = $2", [createdAt, email]);
        } else {
            await pool.query("INSERT INTO customers (name, phone, email, orders_count, first_order, last_order) VALUES ($1,$2,$3,1,$4,$5)",
                [fullName, phone, email, createdAt, createdAt]);
        }

        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Все заявки
app.get('/api/applications', async (req, res) => {
    const { status } = req.query;
    try {
        let result;
        if (status && status !== 'all') {
            result = await pool.query("SELECT * FROM applications WHERE status = $1 ORDER BY created_at DESC", [status]);
        } else {
            result = await pool.query("SELECT * FROM applications ORDER BY created_at DESC");
        }
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Обновить статус заявки
app.put('/api/applications/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const allowed = ['new', 'processed', 'rejected'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Некорректный статус' });
    try {
        const result = await pool.query("UPDATE applications SET status = $1 WHERE id = $2", [status, id]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Заявка не найдена' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Все клиенты
app.get('/api/customers', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM customers ORDER BY last_order DESC");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Статистика
app.get('/api/stats', async (req, res) => {
    try {
        const total = await pool.query("SELECT COUNT(*) as c FROM applications");
        const cust = await pool.query("SELECT COUNT(*) as c FROM customers");
        const newA = await pool.query("SELECT COUNT(*) as c FROM applications WHERE status = 'new'");
        const proc = await pool.query("SELECT COUNT(*) as c FROM applications WHERE status = 'processed'");
        res.json({
            total_applications: parseInt(total.rows[0].c) || 0,
            total_customers: parseInt(cust.rows[0].c) || 0,
            new_applications: parseInt(newA.rows[0].c) || 0,
            processed_applications: parseInt(proc.rows[0].c) || 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. Авторизация
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query("SELECT * FROM admins WHERE username = $1 AND password = $2", [username, password]);
        if (result.rows.length > 0) {
            res.json({ success: true, user: { username: result.rows[0].username } });
        } else {
            res.status(401).json({ error: 'Неверные логин или пароль' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. Экспорт CSV
app.get('/api/export/applications', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM applications ORDER BY created_at DESC");
        let csv = 'ID,ФИО,Возраст,Телефон,Email,Направление,Статус,Примечания,Дата\n';
        result.rows.forEach(a => {
            csv += `"${a.id}","${a.full_name}","${a.age}","${a.phone}","${a.email}","${a.direction_name}","${a.status}","${a.message || ''}","${a.created_at}"\n`;
        });
        res.header('Content-Type', 'text/csv; charset=utf-8');
        res.header('Content-Disposition', 'attachment; filename="applications_export.csv"');
        res.send('\uFEFF' + csv);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== МАРШРУТЫ ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/wrestling.html', (req, res) => res.sendFile(path.join(__dirname, 'wrestling.html')));
app.get('/swimming.html', (req, res) => res.sendFile(path.join(__dirname, 'swimming.html')));
app.get('/athletics.html', (req, res) => res.sendFile(path.join(__dirname, 'athletics.html')));
app.get('/table-tennis.html', (req, res) => res.sendFile(path.join(__dirname, 'table-tennis.html')));
app.get('/gymnastics.html', (req, res) => res.sendFile(path.join(__dirname, 'gymnastics.html')));
app.get('/chess.html', (req, res) => res.sendFile(path.join(__dirname, 'chess.html')));

// ==================== ЗАПУСК ====================
initializeDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log('='.repeat(50));
            console.log(`✅ Сервер запущен на порту ${PORT}`);
            console.log(`🌐 Сайт:    http://localhost:${PORT}/`);
            console.log(`🔧 Админка: http://localhost:${PORT}/admin`);
            console.log('='.repeat(50));
        });
    })
    .catch(err => {
        console.error('❌ Ошибка инициализации БД:', err.message);
        process.exit(1);
    });
