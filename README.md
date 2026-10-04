# e-Comet для OpenCode: эксперимент с установкой из Git

Это экспериментальная сборка для проверки установки и обновления плагина из Git.
Для проверки используется OpenCode 2.0.22. Установка на чистом компьютере и
обновление ещё проверяются; этот пакет пока не является официальным релизом e-Comet.

Добавьте пакет в файл `opencode.json` вашего проекта:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["-e-comet", "github:ShadyAV/e-comet-opencode-preview#main"],
  "snapshots": false
}
```

Откройте проект в OpenCode. Настройте провайдер модели средствами OpenCode,
если он ещё не подключён, затем попросите агента подключить e-Comet и следуйте
инструкции авторизации. Для работы с Wildberries нужны расширение e-Comet в Chrome
и открытая вкладка Wildberries.

Введите `/ecomet-version` в чате: команда покажет версию исполняемого пакета.
Она не обращается к модели или бизнес-инструментам e-Comet.

Команда `/ecomet-update` пока не реализована. Для проверки обновления используется
штатная CLI-команда OpenCode в каталоге проекта:

```sh
opencode plugin update 'github:ShadyAV/e-comet-opencode-preview#main'
```

После обновления проверьте версию через `/ecomet-version`.
Для этого пакета не требуются npm install или сборка JavaScript; установку из Git
и её внешние предпосылки определяет OpenCode.

Лицензия e-Comet находится в LICENSE, лицензии включённых библиотек —
в THIRD-PARTY-LICENSES.
