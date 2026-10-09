const locale = require('../locale');

const FALLBACK_LOCALE = 'zh-CN';

// 依赖插件（如 fastify-account）的错误也可能带 messageId，只翻译本包抛出的错误
const MESSAGE_SCOPE = '@kne/fastify-oidc';

const format = (template, values) => template.replace(/\{(\w+)\}/g, (match, key) => (values && values[key] !== undefined ? String(values[key]) : match));

const fallbackMessage = (messageId, messageValues) => format(locale[FALLBACK_LOCALE][messageId] || messageId, messageValues);

/**
 * 创建带 messageId 的错误：message 先取内置中文，经 translator 按请求语言替换
 */
const createError = (ErrorClass, messageId, messageValues) => {
  const message = fallbackMessage(messageId, messageValues);
  const error = ErrorClass ? new ErrorClass(message) : new Error(message);
  return Object.assign(error, { messageScope: MESSAGE_SCOPE, messageId, messageValues });
};

/**
 * 通过 @kne/fastify-intl 按请求语言翻译；未注册 fastify-intl 或语言包缺失时回退到内置中文
 */
const createTranslator = ({ fastify, options }) => {
  const getIntl = () => {
    const intl = fastify[options.intlNamespace];
    return intl && typeof intl.createIntl === 'function' ? intl : null;
  };

  const getLocale = request => {
    const intl = getIntl();
    return intl && request ? intl.getRequestLocale(request) : null;
  };

  const t = async (target, messageId, messageValues) => {
    const intl = getIntl();
    if (intl) {
      const requestLocale = typeof target === 'string' ? target : getLocale(target);
      for (const lang of [requestLocale, intl.options?.defaultLocale]) {
        if (!lang) {
          continue;
        }
        const instance = await intl.createIntl(lang, options.name);
        if (instance.messages[messageId]) {
          return instance.formatMessage({ id: messageId }, messageValues);
        }
      }
    }
    return fallbackMessage(messageId, messageValues);
  };

  const translateError = async (target, error) => {
    if (error && error.messageScope === MESSAGE_SCOPE && error.messageId) {
      error.message = await t(target, error.messageId, error.messageValues);
    }
    return error;
  };

  const wrap = handler =>
    async function (request, reply) {
      try {
        return await handler.call(this, request, reply);
      } catch (e) {
        throw await translateError(request, e);
      }
    };

  return { getLocale, t, translateError, wrap };
};

module.exports = { locale, createError, createTranslator };
