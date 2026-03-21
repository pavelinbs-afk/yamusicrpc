# Релизы (сборка и GitHub)

Кратко для тех, кто публикует установщики.

## Локальная сборка (Windows)

1. Установите [Node.js](https://nodejs.org/) LTS и [pnpm](https://pnpm.io/) (или используйте `corepack enable`).
2. В корне репозитория:
   ```bash
   pnpm install
   pnpm run dist
   ```
3. Готовые файлы появятся в папке **`release/`**:
   - **`Yandex Music RPC-<версия>-x64.exe`** — установщик NSIS;
   - **`Yandex Music RPC-<версия>-portable.exe`** — portable без установки;
   - **`Yandex Music RPC-<версия>-x64.msi`** — MSI (для MSI на машине сборки нужен WiX; в CI он ставится автоматически).

Без MSI: `pnpm run dist:nomsi` (только NSIS + portable, см. `package.json`).

## Публикация на GitHub Releases

### Автоматически (рекомендуется)

1. Обновите версию в **`package.json`** (поле `version`), закоммитьте.
2. Создайте и отправьте **git-тег** в формате `v*`, например:
   ```bash
   git tag v1.5.1
   git push origin v1.5.1
   ```
3. Сработает workflow **`.github/workflows/release.yml`**: на `windows-latest` выполнится `pnpm install` и `pnpm run dist`, затем **`softprops/action-gh-release`** прикрепит к релизу все **`release/*.exe`** и **`release/*.msi`**.

Убедитесь, что в репозитории включены **Actions** и у них есть право **создавать релизы** (для `GITHUB_TOKEN` в форках/организациях иногда нужны настройки).

### Ручная загрузка

1. Соберите локально (`pnpm run dist`).
2. На GitHub: **Releases → Draft a new release** (или отредактируйте существующий релиз).
3. Укажите тег и название, в блок **Assets** перетащите файлы из **`release/`** (`.exe` и при необходимости `.msi`).
4. Опубликуйте релиз.

### Что скачивают пользователи

- Обычный установщик: **`Yandex Music RPC-*-x64.exe`**.
- Без установки в систему: **`*-portable.exe`**.
- MSI — по желанию (корпоративные сценарии).

Файл **`latest.yml`** в `release/` нужен только приложениям с автообновлением (electron-updater); в текущем `package.json` он не подключён — для ручной раздачи достаточно прикрепить `.exe` / `.msi` к релизу.

## Запуск workflow без тега

При **workflow_dispatch** (кнопка *Run workflow* в GitHub Actions) сборка выполнится, артефакты попадут в **Actions → конкретный run → Artifacts** (`windows-installers`), но к **Release** на GitHub они **не прикрепятся** (в YAML это сделано только для `push` тегов `v*`).
