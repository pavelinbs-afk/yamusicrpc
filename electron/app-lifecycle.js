'use strict';

/** true — реальный выход (трей «Выход»); false — закрытие окна сворачивает в трей */
let quitting = false;

module.exports = {
  isQuitting: () => quitting,
  setQuitting: (v) => {
    quitting = !!v;
  },
};
