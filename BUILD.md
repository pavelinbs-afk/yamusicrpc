Сборка установщика для разработчика репозитория.

Зависимости ставятся через **[pnpm](https://pnpm.io/)**. На машине нужны [Node.js](https://nodejs.org/) и интернет.

## Ошибка Corepack: `Cannot find matching keyid`

Если при вызове `pnpm` падает проверка подписи (несовпадение `keyid` в `corepack.cjs`), это устаревший **Corepack** в составе Node.js относительно текущих ключей реестра менеджеров пакетов. Варианты:

1. **Обновить Node.js** до актуального **LTS** с [nodejs.org](https://nodejs.org/) и снова выполнить `pnpm install` / `pnpm run pack`.
2. **Поставить pnpm без Corepack:**  
   `npm install -g pnpm@9.15.9`  
   (версия совпадает с полем `packageManager` в `package.json`). При необходимости отключите шим Corepack: `corepack disable`, чтобы в PATH использовался глобальный `pnpm`.
3. **Официальный установщик pnpm** для Windows: [pnpm.io/installation](https://pnpm.io/installation) (скрипт или `winget` — см. сайт).

Не смешивайте **`npm install`** и уже созданный **`pnpm install`** в одной папке: лучше удалить `node_modules` и переустановить зависимости одним менеджером.

## Windows: NSIS и длинные пути

Если **`makensis`** падает с `!include: could not open file: ...\node_modules\.pnpm\...\app-builder-lib\...\allowOnlyOneInstallerInstance.nsh`, это лимит длины пути у NSIS при глубокой вложенности **pnpm**. В корне репозитория в **`.npmrc`** задано **`node-linker=hoisted`** (более плоский `node_modules`). После смены режима выполните **`pnpm install`** заново (при сомнениях удалите папку **`node_modules`** и снова установите зависимости). Альтернатива — перенести проект в короткий путь, например `C:\dev\yandex-music-rpc`, или включить поддержку длинных путей в Windows.

## Первый раз: pnpm и зависимости

[Установите pnpm](https://pnpm.io/installation), затем в папке проекта:

```bash
pnpm install --frozen-lockfile
```

## Автоматически (рекомендуется)

При пуше **тега** вида `v1.0.0` GitHub Actions сам поставит pnpm, выполнит `pnpm install --frozen-lockfile`, соберёт установщики и прикрепит файлы к релизу.

## Вручную на своём ПК

Полная команда **`pnpm run dist`** собирает NSIS, portable и **MSI**. Для MSI на сборочной машине нужен [WiX Toolset](https://wixtoolset.org/) 3.11+ (например `choco install wixtoolset` или установщик с сайта). В GitHub Actions WiX ставится автоматически.

Если WiX не установлен, соберите только `.exe` (без MSI):

```bash
pnpm run dist:nomsi
```

Полный набор (включая MSI), при установленном WiX:

```bash
pnpm run dist
```

Готовые файлы — в папке `release/`:

| Файл | Назначение |
|------|------------|
| `Yandex Music RPC-<версия>-x64.exe` | Установщик **NSIS** (мастер, ярлыки) |
| `Yandex Music RPC-<версия>-x64.msi` | Установщик **MSI** (удобно для доменов/политик) |
| `Yandex Music RPC-<версия>-portable.exe` | Портативный вариант, один файл |

После установки любого из вариантов пользователь запускает **Yandex Music RPC** из меню «Пуск» или ярлыка — **Node.js не нужен**.

Разработка из исходников: `pnpm run app` (Electron) или `pnpm run pack` (папка `release/win-unpacked/` с `Yandex Music RPC.exe` без установки).

Чтение трека с ПК: сначала **системный медиа‑транспорт** (`scripts/read-yandex-gsmtc.ps1`, Windows 10 1809+), затем заголовки окон (`scripts/read-yandex-desktop-title.ps1`: процессы **Y.Music.exe**, **Яндекс Музыка.exe**, перечисление HWND). GSMTC даёт исполнителя и название, даже если заголовок окна плеера пустой.

После установки зависимостей строка `[patch-discord-rpc] already patched` и «up to date» — это нормально (патч уже применён, пакеты на месте). В корневом файле настроек отключены лишние сообщения аудита и «fund».
