# Сборка установщиков (Windows)

Кратко для тех, кто собирает `.exe` / `.msi` из исходников.

## Где MSI?

Имя файла: **`Yandex Music RPC-<версия>-x64.msi`** (рядом с `.exe` в папке **`release/`**).

Для MSI нужен **WiX Toolset v3** (например 3.14.x). Без него `electron-builder` собирает только **NSIS `.exe`** и **portable `.exe`**, MSI **не создаётся** — это нормально.

**WiX v4** с `electron-builder` даёт ошибку линковщика **`LGHT0094`** / `Icon:…exe could not be found` — ставьте **v3**, не v4.

```powershell
choco install wixtoolset --version=3.14.1.20250415 -y
```

Если уже стоит **WiX 4**, удалите его, затем поставьте пакет выше. Перезапустите терминал, затем `pnpm run dist`.

Перед каждой сборкой **`pnpm run icon`** создаёт **`build/icon.ico`** и **`electron/icon.ico`** (окно приложения и установщик). После `pnpm install` при отсутствии файлов срабатывает **`scripts/ensure-icon.js`**.

## Команды

1. Установите [Node.js](https://nodejs.org/) LTS и [pnpm](https://pnpm.io/).
2. В корне репозитория:
   ```bash
   pnpm install
   pnpm run dist
   ```
3. Артефакты в **`release/`**:
   - **`Yandex Music RPC-<версия>-x64.exe`** — NSIS;
   - **`Yandex Music RPC-<версия>-portable.exe`** — portable;
   - **`Yandex Music RPC-<версия>-x64.msi`** — MSI (только при установленном WiX v3).

Без MSI: **`pnpm run dist:nomsi`** (только NSIS + portable).

Подробности по окружению и типичным ошибкам сборки — в **[BUILD.md](BUILD.md)**.
