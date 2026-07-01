# 🖼️ X Avatar Proxy

Простий проксі-сервер, який дістає аватарки з X (Twitter) **без API-ключа**.  
Призначений для роботи з **World Cup CT Bracket Builder** та іншими подібними застосунками.

## Як це працює

```
Ваш HTML (фронтенд)  →  цей сервер  →  скрейпить x.com/username
                                          ↓
                                     парсить <meta og:image>
                                          ↓
                                     повертає посилання на pbs.twimg.com
```

Вбудований **кеш на 5 хвилин** та **рейнт-лімітинг** (200 запитів/хв за замовчуванням).

## Швидкий старт

```bash
# 1. Зайти в папку
cd x-avatar-proxy

# 2. Запустити (Node.js вже має бути встановлений)
node server.js

# 3. Перевірити
curl http://localhost:3000/avatar/elonmusk
```

Відповідь:
```json
{
  "username": "elonmusk",
  "avatar_url": "https://pbs.twimg.com/profile_images/..._400x400.jpg",
  "source": "x_scrape"
}
```

## Деплой на Railway / Render / Fly.io

### Railway (найпростіше)
1. Створюєш новий проект на [railway.app](https://railway.app)
2. Вказуєш репозиторій з `x-avatar-proxy/`
3. Railway сам виявить `package.json` і запустить `npm start`
4. Отримуєш домен типу `https://x-avatar-proxy.up.railway.app`
5. Вставляєш цей домен в `index.html` в змінну `PROXY_URL`

### Render
1. Новий Web Service → підключити репозиторій
2. Start Command: `node server.js`
3. Отримуєш `https://x-avatar-proxy.onrender.com`

## Налаштування

| Змінна | Дефолт | Опис |
|--------|--------|------|
| `PORT` | `3000` | Порт сервера |
| `ORIGINS` | `*` | Дозволені CORS-джерела |
| `RATE_LIMIT` | `200` | Ліміт запитів/хв з одного IP |
| `CACHE_TTL` | `300000` | TTL кешу в мілісекундах (5 хв) |

## API

### `GET /avatar/{username}`
Повертає JSON з аватаркою.

### `GET /health`
Перевірка статусу (повертає `{ status: "ok", cacheSize: ... }`).

## Як оновити HTML

У файлі `index.html` знайди:

```js
const PROXY_URL = window.location.hostname === 'localhost' || ...
  ? 'http://localhost:3000'
  : 'https://your-domain.com';     // ← ЗАМІНИТИ НА РЕАЛЬНИЙ ДОМЕН
```

Заміни `https://your-domain.com` на URL твого деплою.

## Ліміти

- **unavatar.io** (запасний варіант): 50 запитів/день — але він використовується **тільки як fallback**
- **Свій сервер**: жодних лімітів, крім власного рейт-ліміту
- **X.com**: сервер скрейпить сторінку, але з кешем на 5 хв — для 16 слотів це всього ~1-2 запити до X

**Важливо:** не став `RATE_LIMIT` надто високим (>1000), інакше X може заблокувати твій сервер.