Сборка установщика для разработчика репозитория.

Зависимости ставятся через **[pnpm](https://pnpm.io/)**. На машине нужны [Node.js](https://nodejs.org/) и интернет.

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

После установки зависимостей строка `[patch-discord-rpc] already patched` и «up to date» — это нормально (патч уже применён, пакеты на месте). В корневом файле настроек отключены лишние сообщения аудита и «fund».
