const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Включаем CORS для всех запросов
app.use(cors());
app.use(express.json());

// Раздаем статические файлы
app.use(express.static(path.join(__dirname, 'public')));

// Хранилище данных
let users = new Map(); // socket.id -> {id, username, name, avatar, online}
let messages = []; // Все сообщения
let userSockets = new Map(); // username -> socket.id

// Генерация ID
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// API: Регистрация
app.post('/api/register', (req, res) => {
    const { username, name, password } = req.body;
    
    // Проверяем существование пользователя
    for (let user of users.values()) {
        if (user.username === username) {
            return res.status(400).json({ error: 'Пользователь с таким username уже существует' });
        }
    }
    
    const userId = generateId();
    const newUser = {
        id: userId,
        username,
        name,
        password, // В реальном приложении нужно хэшировать пароль!
        avatar: null,
        online: false
    };
    
    users.set(userId, newUser);
    
    console.log(`Зарегистрирован новый пользователь: ${username}`);
    res.json({ 
        success: true, 
        user: {
            id: newUser.id,
            username: newUser.username,
            name: newUser.name,
            avatar: newUser.avatar
        }
    });
});

// API: Вход
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    // Ищем пользователя
    let user = null;
    for (let u of users.values()) {
        if (u.username === username && u.password === password) {
            user = u;
            break;
        }
    }
    
    if (!user) {
        return res.status(401).json({ error: 'Неверный username или пароль' });
    }
    
    user.online = true;
    
    res.json({
        success: true,
        user: {
            id: user.id,
            username: user.username,
            name: user.name,
            avatar: user.avatar
        }
    });
});

// API: Поиск пользователей
app.get('/api/users/search', (req, res) => {
    const query = req.query.q || '';
    const currentUserId = req.query.currentUserId;
    
    if (!query) {
        return res.json([]);
    }
    
    const results = [];
    for (let user of users.values()) {
        if (user.id !== currentUserId && 
            (user.username.toLowerCase().includes(query.toLowerCase()) || 
             user.name.toLowerCase().includes(query.toLowerCase()))) {
            results.push({
                id: user.id,
                username: user.username,
                name: user.name,
                avatar: user.avatar,
                online: user.online
            });
        }
    }
    
    res.json(results);
});

// API: Получение пользователя по ID
app.get('/api/users/:id', (req, res) => {
    const user = users.get(req.params.id);
    if (!user) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    res.json({
        id: user.id,
        username: user.username,
        name: user.name,
        avatar: user.avatar,
        online: user.online
    });
});

// API: Получение всех пользователей (кроме текущего)
app.get('/api/users', (req, res) => {
    const currentUserId = req.query.currentUserId;
    const allUsers = [];
    
    for (let user of users.values()) {
        if (user.id !== currentUserId) {
            allUsers.push({
                id: user.id,
                username: user.username,
                name: user.name,
                avatar: user.avatar,
                online: user.online
            });
        }
    }
    
    res.json(allUsers);
});

// API: Обновление профиля
app.put('/api/users/:id', (req, res) => {
    const userId = req.params.id;
    const { username, name, avatar } = req.body;
    
    const user = users.get(userId);
    if (!user) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    // Проверка уникальности username
    if (username !== user.username) {
        for (let u of users.values()) {
            if (u.username === username && u.id !== userId) {
                return res.status(400).json({ error: 'Пользователь с таким username уже существует' });
            }
        }
    }
    
    // Обновляем данные
    user.username = username;
    user.name = name;
    if (avatar) user.avatar = avatar;
    
    // Обновляем в userSockets
    const socketId = userSockets.get(user.username);
    if (socketId) {
        userSockets.delete(user.username);
        userSockets.set(username, socketId);
    }
    
    // Уведомляем всех о смене профиля
    io.emit('userUpdated', {
        id: user.id,
        username: user.username,
        name: user.name,
        avatar: user.avatar,
        online: user.online
    });
    
    res.json({ success: true });
});

// Socket.io соединения
io.on('connection', (socket) => {
    console.log('Новое соединение:', socket.id);
    
    // Авторизация пользователя
    socket.on('authenticate', (userData) => {
        const { id, username } = userData;
        const user = users.get(id);
        
        if (user) {
            user.online = true;
            userSockets.set(username, socket.id);
            socket.userId = id;
            socket.username = username;
            
            console.log(`Пользователь онлайн: ${username} (${socket.id})`);
            
            // Отправляем список всех пользователей
            const allUsers = [];
            for (let u of users.values()) {
                if (u.id !== id) {
                    allUsers.push({
                        id: u.id,
                        username: u.username,
                        name: u.name,
                        avatar: u.avatar,
                        online: u.online
                    });
                }
            }
            socket.emit('allUsers', allUsers);
            
            // Уведомляем всех о новом онлайн пользователе
            socket.broadcast.emit('userOnline', {
                id: user.id,
                username: user.username,
                name: user.name,
                avatar: user.avatar
            });
        }
    });
    
    // Отправка сообщения
    socket.on('sendMessage', (data) => {
        const { to, text } = data;
        const fromUser = users.get(socket.userId);
        
        if (!fromUser) return;
        
        const message = {
            id: generateId(),
            from: socket.userId,
            to: to,
            text: text,
            timestamp: new Date().toISOString(),
            read: false
        };
        
        messages.push(message);
        
        // Отправляем сообщение отправителю
        socket.emit('newMessage', {
            ...message,
            direction: 'outgoing',
            user: {
                id: fromUser.id,
                username: fromUser.username,
                name: fromUser.name,
                avatar: fromUser.avatar
            }
        });
        
        // Отправляем сообщение получателю, если он онлайн
        const recipientSocketId = userSockets.get(to);
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('newMessage', {
                ...message,
                direction: 'incoming',
                user: {
                    id: fromUser.id,
                    username: fromUser.username,
                    name: fromUser.name,
                    avatar: fromUser.avatar
                }
            });
        }
    });
    
    // Получение истории сообщений
    socket.on('getMessages', (data) => {
        const { withUserId } = data;
        const userId = socket.userId;
        
        const chatMessages = messages.filter(msg => 
            (msg.from === userId && msg.to === withUserId) ||
            (msg.from === withUserId && msg.to === userId)
        ).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        
        socket.emit('messagesHistory', {
            withUserId: withUserId,
            messages: chatMessages
        });
    });
    
    // Отключение пользователя
    socket.on('disconnect', () => {
        console.log('Отключение:', socket.id);
        
        if (socket.userId) {
            const user = users.get(socket.userId);
            if (user) {
                user.online = false;
                userSockets.delete(user.username);
                
                // Уведомляем всех о выходе пользователя
                socket.broadcast.emit('userOffline', user.id);
            }
        }
    });
});

// Старт сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log(`Доступен по адресу: http://localhost:${PORT}`);
});