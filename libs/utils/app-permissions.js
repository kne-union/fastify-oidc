const crypto = require('node:crypto');

const TENANT_SYNC_EVENT = 'urn:kne:oidc:tenant-sync';

/**
 * 子应用权限在宿主侧统一挂在 `${prefix}:<appCode>:` 之下，模块 code `${prefix}:<appCode>` 即租户是否开通该应用的开关
 */
const appModuleCode = (prefix, appCode) => `${prefix}:${appCode}`;

const scopePermissions = (permissions, appCode, prefix) => {
  const head = `${appModuleCode(prefix, appCode)}:`;
  return [...new Set((permissions || []).filter(code => typeof code === 'string' && code.startsWith(head)).map(code => code.slice(head.length)))];
};

const isAppEnabledIn = (permissions, appCode, prefix) => (permissions || []).includes(appModuleCode(prefix, appCode));

const wrapAppTree = ({ prefix, centerName, app }) => ({
  modules: [
    {
      code: prefix,
      name: centerName,
      index: -2,
      modules: [
        {
          code: app.code,
          name: app.name || app.code,
          modules: app.permissions?.modules || [],
          permissions: app.permissions?.permissions || []
        }
      ]
    }
  ]
});

const countPermissions = tree => {
  let count = 0;
  const walk = modules =>
    (modules || []).forEach(module => {
      count += (module.permissions || []).length;
      walk(module.modules);
    });
  walk(tree?.modules);
  return count + (tree?.permissions || []).length;
};

const hashPermissions = tree =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(tree || {}))
    .digest('hex');

module.exports = { TENANT_SYNC_EVENT, appModuleCode, scopePermissions, isAppEnabledIn, wrapAppTree, countPermissions, hashPermissions };
