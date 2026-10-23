# fastify-oidc

### 描述

基于 oidc-provider 的 Fastify OIDC 认证插件，支持 standalone / central 多项目单点登录、租户与跨项目令牌

### 关键词

fastify, oidc, oauth2, sso, oidc-provider, authentication, jwt, pkce, dpop, token-exchange, multi-tenant, kne

### 安装

```shell
npm i --save @kne/fastify-oidc
```

### 概述

#### 项目概述

`@kne/fastify-oidc` 基于 [oidc-provider](https://github.com/panva/node-oidc-provider) 为 kne 体系的 Fastify 项目提供 OIDC / OAuth 2.0 认证能力，解决多个业务项目之间的统一登录、租户上下文传递与跨项目调用问题。

同一个插件按 `mode` 扮演两种角色：

| 模式 | 角色 | 说明 |
|------|------|------|
| `standalone` | IdP + 资源服务 | 内嵌 OIDC Provider，账号来自 `@kne/fastify-account`，租户 / 角色 / 权限来自 `@kne/fastify-tenant`；单独部署的项目和"主项目"都用此模式 |
| `central` | 资源服务 + Client | 不启动 IdP、不建 OIDC 表，用主项目的 JWKS 验签，用户在本地 fastify-account 中按 `sub` 建镜像 |

> **关键设计**：业务代码只依赖 `fastify.oidc.authenticate.*` 填充的 `request.user`（以及兼容字段 `request.userInfo` / `request.authenticatePayload` / `request.tenantUserInfo`），从 standalone 切换到 central 只需改环境变量。

#### 核心架构与流程

```
                         ┌──────────────────────── 主项目（standalone） ────────────────────────┐
 浏览器 SPA               │                                                                      │
 (components-admin Oidc)  │  /oidc/*  oidc-provider（授权、token、jwks、end_session）              │
   │ 1.授权请求(PKCE)  ──→ │     ↓ 需要交互                                                        │
   │ 2.前端交互页 /oidc-interaction?uid=  ←── /api/oidc/interaction/{uid}（303）                  │
   │ 3.登录/选租户/确认 ──→ │  /api/oidc/interaction/{uid}/login|tenant|confirm|abort             │
   │                       │     ↓ identity.js（fastify-account.verifyCredentials / fastify-tenant）│
   │ 4.code → token    ──→ │  JWT access_token（aud=资源、带租户 claims、sid）                      │
   │ 5.Bearer/DPoP 调 API → │  authenticate.user → request.user                                    │
   │                       └──────────────────────────────────────────────────────────────────────┘
   │                                          ↑ JWKS / client_credentials / back-channel logout
   │                       ┌──────────── 子项目（central） ────────────┐
   └── 同一 IdP 会话 SSO ─→ │  authenticate.user（远程 JWKS 验签）       │
                           │  user-mirror（按 sub 建本地用户镜像）       │
                           │  /api/oidc/backchannel-logout（登出通知）  │
                           └───────────────────────────────────────────┘
```

| 环节 | 实现 | 说明 |
|------|------|------|
| 协议端点 | `libs/idp/mount.js` | 把 `mountPath`（默认 `/oidc`）下的请求原样交给 oidc-provider |
| 交互 | `libs/services/interaction.js` | 登录、选择租户、授权确认、取消，返回 `{ redirectTo }` 由前端跳转 |
| 账号 / 租户桥接 | `libs/idp/identity.js` | 唯一依赖 fastify-account / fastify-tenant 的地方 |
| 资源侧鉴权 | `libs/resource/*` | JWT 验签、DPoP、撤销列表、`request.user` 归一化、legacy token 回退 |
| 管理 | `libs/controllers/admin.js` | client、资源服务、签名密钥、会话 |

#### 核心概念详解

##### 资源服务（Resource Server）与 audience

每个需要 access_token 的 API 是一个资源服务，`identifier` 即 token 的 `aud`。默认自动注册：

| 资源 | identifier | scope | 用途 |
|------|------------|-------|------|
| 本项目 API（名称为 `name`） | `${ORIGIN}/api` | `api` | SPA 调用本项目接口 |
| 服务接口 | `${issuer origin}${prefix}` | `user:read tenant:read app:register tenant:sync` | 子项目以 client_credentials 读取用户 / 租户、注册应用、回拉租户快照 |

client 只能申请 `allowedResources` 中的资源；子项目 token 的 `aud` 是子项目 API，拿到主项目会被拒绝。

##### 租户上下文

登录后增加一个自定义交互步骤 `tenant`（位于 login 与 consent 之间），选定的租户按 IdP 会话保存：

| 情况 | 行为 |
|------|------|
| 用户不属于任何租户 | 跳过，token 不带租户 claims |
| 只属于一个租户 | 自动选中 |
| 多个租户 | 前端展示租户列表 |
| 授权请求带 `tenant_id` 且用户是成员 | 静默切换（可配合 `prompt=none`） |
| 授权请求带的 `tenant_id` 无效，用户只有一个可用租户 | 自动选中该租户，不展示列表 |
| 授权请求带的 `tenant_id` 无效，用户有多个可用租户 | 前端展示租户列表（`prompt=none` 时返回 `interaction_required`） |
| 会话中的租户已不再有效（被移出、关闭） | 重新判断上面几种情况 |

token 中的租户相关 claim 以命名空间为前缀（默认 `${ORIGIN}/`，central 模式为 issuer 的 origin）：`tenant_id`、`tenant_user_id`、`roles`、`permissions`（按资源服务 `includePermissions` 决定是否携带）。

##### 令牌撤销

JWT access_token 无法真正撤销，插件在资源侧维护一个撤销列表：

| 触发 | 撤销方式 |
|------|----------|
| RP-Initiated Logout（standalone） | 会话中各 client 的 `sid` 加入撤销列表 |
| Back-Channel Logout（central） | 子项目收到 logout_token 后撤销 `sid`（无 sid 时按 `sub`） |
| 权限变化 `onPermissionChange` | 撤销该用户所有 grant / refresh token，并拒绝撤销时间之前签发的 token；IdP 会话保留，前端静默重新获取带新权限的 token |
| 管理接口强制下线 | 同上，并结束 IdP 会话、发送 back-channel logout |

> **注意**：撤销列表默认存内存，多实例部署时需通过 `revocationStore` 传入共享存储（见 API 文档）。central 子项目的撤销列表与主项目相互独立，权限变化只在主项目生效，子项目依赖较短的 access_token 有效期（默认 10 分钟）。

#### 主要特性

| 特性 | 说明 |
|------|------|
| 授权码 + PKCE | SPA 公共 client，`token_endpoint_auth_method: none` |
| JWT access_token | RS256 签名，`typ: at+jwt`，按资源服务区分 `aud` |
| Refresh Token 轮转 | 每次刷新签发新 refresh token，旧的立即失效 |
| 多租户 | 交互式 / 自动 / 静默切换租户，租户信息写入 token |
| 应用中心 | 子应用把权限树注册到宿主「应用中心」节点，宿主按租户开关子应用及其功能；client / independent 两种租户模式 |
| SSO | 多个项目共用主项目 IdP 会话 |
| RP-Initiated Logout / Back-Channel Logout | 登出时通知所有子项目 |
| DPoP | 前端可选启用，token 与浏览器密钥绑定，资源侧校验 proof 与重放 |
| Client Credentials | 服务间调用，token 带 `client_token` 标记，只能访问 `authenticate.client` 保护的接口 |
| Token Exchange（RFC 8693） | 服务端代用户换取访问其它资源服务的 token，token 带 `act` |
| 签名密钥轮换 | active / next / retired 三态，多实例定期检测并热加载 |
| 兼容旧 token | `legacyToken` 开启时，无 `Authorization` 头回退到 fastify-account 的 `x-user-token` |
| 国际化 | 注册 @kne/fastify-intl 后错误信息、协议错误描述、登出页按请求语言返回（内置 `zh-CN` / `en-US`） |

#### 使用方法

##### 主项目 / 独立项目（standalone）

注册顺序：`fastify-sequelize` → `fastify-account` → `fastify-tenant` → `fastify-oidc`。

```js
// server 插件注册
// 可选：注册后错误信息按请求语言（x-user-locale / accept-language）返回，否则固定返回中文
fastify.register(require('@kne/fastify-intl'), { defaultLocale: 'zh-CN' });

fastify.register(require('@kne/fastify-account'), {
  // 让 fastify-account 自身的接口（如 getUserInfo）也接受 OIDC access_token
  getUserAuthenticate: () => fastify.oidc.authenticate.user
});

fastify.register(require('@kne/fastify-tenant'), {
  getUserAuthenticate: () => fastify.oidc.authenticate.user,
  // 角色 / 成员 / 租户变化后撤销已签发的 token
  onPermissionChange: payload => fastify.oidc.onPermissionChange(payload)
});

fastify.register(require('@kne/fastify-oidc'), {
  // mode / origin / keyEncryptionSecret 默认读取环境变量，见下表
});

// 其它 kne 插件的 getAuthenticate 改用 fastify.oidc.authenticate
fastify.register(require('@kne/fastify-file-manager'), {
  getAuthenticate: () => [fastify.oidc.authenticate.user]
});
```

| 环境变量 | 必填 | 说明 |
|----------|------|------|
| `ORIGIN` | 是 | 本项目对外访问的 origin，如 `https://a.example.com` |
| `AUTH_MODE` | 否 | `standalone`（默认）/ `central` |
| `OIDC_IS_MAIN` | 否 | `true` 表示主系统（子项目以本项目为 IdP），前端登录页据此不显示 SSO 入口 |
| `OIDC_KEY_SECRET` | 是（standalone） | 加密签名私钥与 client_secret 的密钥，未配置时使用不安全的默认值并告警 |
| `OIDC_COOKIE_SECRET` | 否 | 交互 cookie 签名密钥，默认由 `OIDC_KEY_SECRET` 派生 |

`fastify.sequelize.sync()` 完成后 IdP 才会初始化（生成密钥、写入默认 client / 资源服务），此前访问 `/oidc/*` 返回 503；需要等待时可 `await fastify.oidc.whenReady()`。

##### 子项目（central）

```js
fastify.register(require('@kne/fastify-account'), {
  getUserAuthenticate: () => fastify.oidc.authenticate.user
});
fastify.register(require('@kne/fastify-oidc'), {
  mode: 'central'
});
```

| 环境变量 | 必填 | 说明 |
|----------|------|------|
| `AUTH_MODE` | 是 | `central` |
| `ORIGIN` | 是 | 子项目 origin |
| `OIDC_ISSUER` | 是 | 主项目 issuer，如 `https://a.example.com/oidc` |
| `OIDC_CLIENT_ID` | 否 | 子项目 SPA 在主项目注册的 client_id，默认 `oidc-spa` |
| `OIDC_SERVICE_CLIENT_ID` / `OIDC_SERVICE_CLIENT_SECRET` | 建议 | 子项目服务端 client，用于拉取用户资料（镜像）与远程租户信息 |

在主项目管理后台（或 `clients` / `resourceServers` 选项）登记子项目：

```js
// 主项目 fastify-oidc 选项
{
  resourceServers: [{ identifier: 'https://b.example.com/api', name: 'B 项目 API' }],
  clients: [
    {
      clientId: 'b-spa',
      redirect_uris: ['https://b.example.com/oidc-callback'],
      post_logout_redirect_uris: ['https://b.example.com/'],
      backchannel_logout_uri: 'https://b.example.com/api/oidc/backchannel-logout',
      backchannel_logout_session_required: true,
      allowedResources: ['https://b.example.com/api']
    },
    {
      clientId: 'b-service',
      grant_types: ['client_credentials'],
      response_types: [],
      token_endpoint_auth_method: 'client_secret_basic',
      allowedResources: ['https://a.example.com/api/oidc']
    }
  ]
}
```

> **建议**：子项目 client 配置 `backchannel_logout_session_required: true`，登出通知会携带 `sid`，子项目只撤销该会话的 token；否则按用户撤销。

##### 子应用与应用中心

宿主显式传入 fastify-tenant 开启应用中心：

```js
// 宿主（standalone）
fastify.register(require('@kne/fastify-oidc'), {
  tenant: () => fastify.tenant
});
```

子应用以 central 模式接入，并声明 `app`。宿主登记的服务 client 需要 `allowedResources` 包含服务接口资源；client 模式开启 `tenantProxy` 时还需 token exchange 与宿主 API 资源：

```js
// client 模式：租户相关接口与数据全部由宿主提供
fastify.register(require('@kne/fastify-oidc'), {
  mode: 'central',
  tenantProxy: true, // 可选：/api/tenant/* 由宿主提供
  app: {
    code: 'crm',
    name: 'CRM',
    tenantMode: 'client',
    permissions: { modules: [{ code: 'order', name: '订单', permissions: [{ code: 'view', name: '查看' }] }] }
  }
});

// independent 模式：本地 fastify-tenant，宿主同步过来的租户由宿主接管
fastify.register(require('@kne/fastify-tenant'), { getUserAuthenticate: () => fastify.oidc.authenticate.user });
fastify.register(require('@kne/fastify-oidc'), {
  mode: 'central',
  tenant: () => fastify.tenant,
  app: { code: 'erp', name: 'ERP', tenantMode: 'independent' } // 权限树默认取 fastify.tenant.permissions
});
```

| 模式 | 租户来源 | 权限 | 说明 |
|------|----------|------|------|
| client | 宿主（`tenantSource = remote`） | 宿主下发，已去 `apps:<code>:` 前缀 | 只能选择已开通本应用的租户 |
| independent | 本地 fastify-tenant | 本地计算 | 宿主同步的租户（托管租户）只读；本地自建租户不受影响 |

> **注意**：托管租户名与本地租户重名时追加 `（宿主）` 后缀（仍冲突依次为 `（宿主2）`……）；组织架构完全以宿主为准，子应用不能在托管租户下补充部门。independent 模式依赖 fastify-tenant 的托管租户能力（`services.managed`），需同时升级 fastify-tenant。

> **注意**：应用中心停用或删除某应用后，该应用的 client 登录不带任何租户与权限；independent 应用的托管租户会收到推送并关闭，宿主删除租户时同样关闭。删除的应用在子应用重启重新注册后恢复。宿主拒绝注册（如编码已被占用）时子应用停止重试，需修正配置后重启。

##### 前端

前端使用 components-admin 的 `Oidc` 模块（授权码 + PKCE，可选 DPoP），管理后台使用 `OidcAdmin` 模块。默认路径：

| 路径 | 组件 | 说明 |
|------|------|------|
| `/oidc-interaction` | `components-admin:Oidc@Interaction` | 登录交互页（`interactionPage`），参数 `uid`；仅 IdP 项目需要 |
| `/oidc-callback` | `components-admin:Oidc@Callback` | 授权回调页（`callbackPath`） |

在 `preset.js` 中创建 client，并接入 ajax 拦截器与 preset：

```js
import { loadModule } from '@kne/remote-loader';
import createAjax from '@kne/axios-fetch';

export const globalInit = async () => {
  const { default: createOidcClient } = await loadModule('components-admin:Oidc@createOidcClient');
  const oidc = createOidcClient({
    issuer: window.runtimeOidcIssuer || `${window.location.origin}/oidc`,
    clientId: window.runtimeOidcClientId,
    resource: `${window.location.origin}/api`
  });
  const ajax = createAjax({
    baseURL: baseApiUrl,
    errorHandler: error => message.error(error),
    registerInterceptors: interceptors => oidc.registerInterceptors(interceptors)
  });
  // ...fetchPreset / remoteLoaderPreset 同原有配置
  return { ajax, oidc, apis: getApis() };
};
```

需要登录的路由用 `components-admin:Oidc@OidcAuthenticate` 包裹（替代原 `X-User-Token` 登录跳转），原有的 `UserInfo` / `AfterUserLoginLayout` 可继续使用：请求已自动携带 `Authorization`，fastify-account 的 `authenticate.user` 通过 `getUserAuthenticate` 委托给 fastify-oidc 校验。租户切换使用 `components-admin:Oidc@TenantSwitch`，退出使用 `components-admin:Oidc@OidcLogout`。

> **注意**：前端路由不能放在 issuer 路径（默认 `/oidc`）下，否则会被 oidc-provider 接管。`clientId`、`resource` 需与 `OIDC_CLIENT_ID`、`OIDC_AUDIENCE` 一致，`redirectUri` 需在 client 的 `redirect_uris` 中登记。

##### 运行环境

oidc-provider 9.x 为 ESM 包，本插件通过动态 `import()` 加载，要求 Node.js `>= 22.12`；在 oidc-provider 未列入支持范围的 Node 版本上启动时会输出 `Unsupported runtime` 警告，不影响运行。


### 示例

### API

#### 配置项

##### 基础

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| name | string | 否 | `oidc` | 命名空间名称，即 `fastify.oidc` |
| prefix | string | 否 | `/api/oidc` | 插件接口前缀（交互、管理、服务接口） |
| dbTableNamePrefix | string | 否 | `t_` | 表名前缀，表名形如 `t_oidc_payload` |
| mode | string | 否 | `AUTH_MODE` 或 `standalone` | `standalone` / `central` |
| isMain | boolean | 否 | `OIDC_IS_MAIN === 'true'` | 是否为主系统（其它子项目以本项目为 IdP），仅 standalone 有效；通过 `GET /api/oidc/config` 告知前端，主系统登录页不显示 SSO 入口 |
| origin | string | 是 | `ORIGIN` | 本项目对外 origin |
| issuer | string | central 必填 | `OIDC_ISSUER`；standalone 为 `${origin}${mountPath}` | issuer 必须带路径 |
| mountPath | string | 否 | `/oidc` | standalone 未配置 issuer 时 IdP 的挂载路径 |
| audience | string | 否 | `OIDC_AUDIENCE` 或 `${origin}/api` | 本项目 API 的资源标识，即 access_token 的 `aud` |
| clientId | string | 否 | `OIDC_CLIENT_ID` 或 `${name}-spa` | 本项目 SPA 的 client_id |
| claimNamespace | string | 否 | standalone 为 `${origin}/`，central 为 `${issuer origin}/` | 自定义 claim 前缀 |
| accountNamespace | string | 否 | `account` | fastify-account 命名空间 |
| tenantNamespace | string | 否 | `tenant` | fastify-tenant 命名空间，不存在时不启用租户；未传 `tenant` 时使用 |
| tenant | object / function | 否 | `null` | 显式传入 fastify-tenant（对象或 getter，如 `() => fastify.tenant`）。standalone 传入后开启应用中心；central 的 independent 子应用必填，指向本地 fastify-tenant；不传时回退 `fastify[tenantNamespace]`，不开启应用中心 |
| intlNamespace | string | 否 | `intl` | @kne/fastify-intl 命名空间，不存在时返回内置中文文案 |
| fileNamespace | string | 否 | `fileManager` | @kne/fastify-file-manager 命名空间：主项目用它把头像 id 解析成 `avatarUrl`，子项目用它把头像拷到本地文件库；不存在时不处理头像 |

##### IdP（standalone）

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| keyEncryptionSecret | string | 是 | `OIDC_KEY_SECRET` | 加密签名私钥、client_secret；未配置时使用不安全默认值并告警 |
| cookieSecret | string | 否 | `OIDC_COOKIE_SECRET`，否则由 keyEncryptionSecret 派生 | 交互 cookie 签名 |
| trustProxy | boolean | 否 | `true` | 信任 `X-Forwarded-*`（部署在反向代理后） |
| allowPrivateFetch | boolean / function | 否 | `false` | oidc-provider 默认禁止向内网 / 回环地址发请求（back-channel logout 等）；内网部署时设为 `true` 或 `url => boolean` |
| adapter | function | 否 | `null` | 自定义存储 adapter（如 Redis），见「自定义 adapter」 |
| ttl | object | 否 | 见下表 | 各类令牌有效期（秒） |
| clockTolerance | number | 否 | `5` | 时钟偏差容忍（秒） |
| retiredKeyTTL | number | 否 | `172800` | 退役密钥保留时长（秒），应大于 access_token / id_token 最长有效期 |
| keyReloadInterval | number | 否 | `60` | 多实例检测密钥变化的间隔（秒），`0` 关闭 |
| cleanupInterval | number | 否 | `3600` | 清理过期数据间隔（秒），`0` 关闭 |
| interactionPage | string | 否 | `/oidc-interaction` | 前端交互页路径 |
| callbackPath | string | 否 | `/oidc-callback` | 本项目 SPA 回调路径（用于默认 client） |
| includePermissions | boolean | 否 | `false` | 资源服务未设置时，token 是否携带 permissions |
| defaultResourceScope | string | 否 | `api` | 资源服务默认 scope |
| seedSelf | boolean | 否 | `true` | 启动时自动登记本项目 SPA client、本项目 API、服务接口资源 |
| selfClient | object | 否 | `{}` | 覆盖默认 SPA client 的字段与 metadata，如 `{ clientName: '系统名称' }`（默认名称为 `name`）；仅首次登记时生效；已存在的 client 只会追加缺失的 `redirect_uris` / `post_logout_redirect_uris` / `allowedResources`（如 `ORIGIN` 变更），其他字段不覆盖 |
| clients | array | 否 | `[]` | 启动时登记的 client（已存在则只追加缺失的 `redirect_uris` / `post_logout_redirect_uris` / `allowedResources`），字段同管理接口 `client/create`，metadata 直接平铺 |
| resourceServers | array | 否 | `[]` | 启动时登记的资源服务（已存在则只追加配置中新增的 scope，其他字段不覆盖） |
| serviceScopes | array | 否 | `['user:read', 'tenant:read', 'app:register', 'tenant:sync']` | 服务接口资源的 scope；已登记的服务接口资源启动时会补齐新增的 scope |
| appPermissionPrefix | string | 否 | `apps` | 应用中心根节点 code，子应用权限挂在 `apps:<appCode>:` 下 |
| appCenterName | string | 否 | `应用中心` | 应用中心根节点名称 |
| tenantSyncDebounce | number | 否 | `1000` | 同一租户变更通知的防抖时长（毫秒），合并导入 / 同步成员时的大量事件 |
| tenantSyncTimeout | number | 否 | `10000` | 推送通知的请求超时（毫秒） |
| tenantSyncTokenTTL | number | 否 | `300` | `tenant_sync_token` 有效期（秒） |
| getAuthenticate | function | 否 | 见下文 | 管理接口鉴权，参数为 `client:manage` / `resource-server:manage` / `key:manage` / `session:manage` / `app:manage` |

`ttl` 默认值：

| 键 | 默认值 | 说明 |
|----|--------|------|
| accessToken | `600` | access_token，资源服务可单独配置 |
| idToken | `3600` | id_token |
| refreshToken | `1209600` | refresh_token（14 天） |
| interaction | `600` | 登录交互 |
| session | `1209600` | IdP 会话 |
| grant | `1209600` | 授权记录 |

`getAuthenticate` 默认：`*:manage` 返回 `[authenticate.user, authenticate.admin]`，其余返回 `[authenticate.user]`。

##### 资源侧

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| legacyToken | boolean | 否 | `true` | 无 `Authorization` 头时回退到 fastify-account 的 `x-user-token` |
| requireDPoP | boolean | 否 | `false` | 只接受 DPoP 绑定的 token |
| tenantSource | string | 否 | standalone 且有 fastify-tenant 为 `local`；client 子应用为 `remote`；independent 子应用为 `local`（本地托管租户）；否则 `claims` | `authenticate.tenantUser` 的数据来源：`local` 实时查本地 fastify-tenant；`claims` 由 token 构造；`remote` 调主项目服务接口 |
| tenantUserContextName | string | 否 | `tenantUserInfo` | 租户用户挂载到 request 上的字段名 |
| revocationStore | object | 否 | 内存 | 撤销列表存储，见「撤销列表存储」 |
| dpopReplayStore | object | 否 | 内存 | DPoP proof 防重放存储，接口同 revocationStore |
| getRequestUrl | function | 否 | `${origin}${request.raw.url}` | 计算 DPoP `htu` 比对用的请求地址 |
| serviceClient | object | 否 | `{ clientId: OIDC_SERVICE_CLIENT_ID, clientSecret: OIDC_SERVICE_CLIENT_SECRET }` | 服务端 client（central 拉取用户资料、远程租户、token exchange） |
| serviceAudience | string | 否 | `${issuer origin}${prefix}` | 服务接口资源标识 |
| idpApiBase | string | 否 | `${issuer origin}${prefix}` | 主项目服务接口地址 |
| jwksUri | string | 否 | `${issuer}/jwks` | central 模式远程 JWKS 地址 |
| userMirrorTTL | number | 否 | `600` | central 模式用户镜像缓存时长（秒） |

##### 子应用（central）

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| app | object | 否 | `null` | 配置后作为宿主应用中心的子应用，启动时注册权限，见下表。环境变量 `OIDC_APP_CODE` / `OIDC_APP_NAME` / `OIDC_APP_TENANT_MODE` / `OIDC_APP_TENANT_SYNC_URI` 覆盖同名字段，托管平台可通过它们注入；代码里可只写默认值（如 `{ tenantMode: 'independent' }`），合并后没有 `code` 视为未作为子应用部署（本地独立运行不受影响） |
| appRegisterRetryMax | number | 否 | `300` | 注册失败退避重试的最大间隔（秒）；宿主返回 4xx（408、429 除外，如编码已被占用、未授权 scope）时停止重试并记错误日志，修正配置后重启 |
| tenantProxy | boolean / object | 否 | `false` | client 模式开启 `/api/tenant` 代理；对象可配 `prefix`（默认 `/api/tenant`）、`resource`（默认 `${issuer origin}/api`，token exchange 的目标资源）、`target`（默认 `${issuer origin}${prefix}`） |
| tenantSyncTTL | number | 否 | `600` | independent 模式托管租户的过期时长（秒），过期后请求时后台回拉 |
| tenantSyncPageSize | number | 否 | `200` | independent 模式回拉成员的分页大小 |

`app` 字段：

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| code | string | 是 | - | 应用编码，只能包含字母、数字、`_`、`-`；首次注册后绑定当前 serviceClient |
| name | string | 否 | `code` | 应用名称，即权限树中应用节点名称 |
| description | string | 否 | - | 描述 |
| tenantMode | string | 否 | `client` | `client` / `independent` |
| permissions | object | client 必填 | independent 取 `tenant.permissions` | 权限树 `{ modules }`，code 不带 `apps` 前缀 |
| tenantSyncUri | string | 否 | independent 为 `${origin}${prefix}/tenant-sync` | 接收宿主变更通知的地址 |

#### 接口

##### OIDC 协议端点（standalone）

挂载在 issuer 路径下（默认 `/oidc`），由 oidc-provider 提供，以 `GET {issuer}/.well-known/openid-configuration` 为准：

| 端点 | 路径 | 说明 |
|------|------|------|
| discovery | `GET /oidc/.well-known/openid-configuration` | 元数据 |
| authorization | `GET /oidc/auth` | 授权请求，额外支持 `tenant_id` 参数 |
| token | `POST /oidc/token` | authorization_code / refresh_token / client_credentials / token-exchange |
| jwks | `GET /oidc/jwks` | 公钥集 |
| userinfo | `GET /oidc/me` | 用户信息（需 issuer 作为 aud 的 token） |
| end_session | `GET /oidc/session/end` | RP-Initiated Logout |
| revocation / introspection | `POST /oidc/token/revocation`、`POST /oidc/token/introspection` | 撤销、内省 |

##### 前端登录配置（standalone / central）

###### GET /api/oidc/config

免登录，供前端登录页判断是否支持 SSO 以及当前模式（如 components-admin 的 Account 登录页）。只返回公开信息：

```json
{
  "mode": "central",
  "isMain": false,
  "issuer": "https://main.example.com/oidc",
  "clientId": "child-spa",
  "audience": "https://child.example.com/api"
}
```

| 字段 | 说明 |
|------|------|
| mode | `standalone` / `central` |
| isMain | 是否为主系统（`isMain` 配置），central 恒为 `false` |
| issuer | IdP issuer；central 为主项目 issuer |
| clientId | 本项目前端使用的 client_id（`clientId` 配置，默认 `oidc-spa`） |
| audience | 本项目资源服务标识 |

##### 登录交互（standalone）

前端交互页通过以下接口驱动流程，均依赖交互 cookie，需与 IdP 同源调用。成功时返回 `{ redirectTo }`，前端 `window.location` 跳转即可。

###### GET /api/oidc/interaction/{uid}

oidc-provider 的交互地址，303 跳转到 `${ORIGIN}${interactionPage}?uid={uid}`。

###### GET /api/oidc/interaction/{uid}/details

获取当前步骤：

```json
{
  "uid": "xxx",
  "prompt": { "name": "login", "reasons": ["no_session"], "details": {} },
  "params": { "clientId": "oidc-spa", "scope": "openid profile offline_access api", "resource": "https://a.example.com/api", "tenantId": null, "loginHint": null, "uiLocales": null },
  "client": { "clientId": "oidc-spa", "clientName": "oidc 前端", "logoUri": null, "clientUri": null },
  "user": null,
  "tenants": null
}
```

`prompt.name` 为 `login` / `tenant` / `consent`；已登录时 `user` 为 `{ id, nickname, avatar, email, phone }`；`tenant` 步骤时 `tenants` 为 `{ list: [{ tenantId, tenantUserId, name, logo, companyName }], defaultTenantId }`。

###### POST /api/oidc/interaction/{uid}/login

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| type | string | 否 | `email` | `email` / `phone` |
| email / phone | string | 否 | - | 账号 |
| password | string | 是 | - | 与 fastify-account 登录一致（前端 md5） |
| remember | boolean | 否 | `true` | `false` 时 IdP 会话随浏览器关闭失效 |

账号密码错误返回 400；账号状态不是 0 / 1 时返回 `{ status }`（与 fastify-account 登录一致，由前端处理如重置密码）。

###### POST /api/oidc/interaction/{uid}/tenant

参数 `tenantId`（必填）。只能选择当前用户所属且开启的租户。

###### POST /api/oidc/interaction/{uid}/confirm

确认授权（`skip_consent: false` 的 client 才会出现 consent 步骤）。

###### POST /api/oidc/interaction/{uid}/abort

取消登录，client 回调收到 `error=access_denied`。

##### 管理接口（standalone）

列表 `GET`（`filter`、`perPage`、`currentPage`），写操作 `POST`，`save` / `set-status` / `remove` 返回 `{}`。

| 接口 | 说明 | 鉴权 type |
|------|------|-----------|
| `GET /api/oidc/admin/client/list` | client 列表（`filter.keyword` / `filter.status`），不返回 secret | `client:manage` |
| `GET /api/oidc/admin/client/detail?id=` | client 详情 | `client:manage` |
| `POST /api/oidc/admin/client/create` | 创建，参数 `clientId`、`clientName`、`clientSecret`、`metadata`、`allowedResources`、`description`；confidential client 返回一次明文 `clientSecret` | `client:manage` |
| `POST /api/oidc/admin/client/save` | 修改 | `client:manage` |
| `POST /api/oidc/admin/client/set-status` | `{ id, status: open / closed }` | `client:manage` |
| `POST /api/oidc/admin/client/remove` | 删除 | `client:manage` |
| `POST /api/oidc/admin/client/rotate-secret` | 重置 secret，返回 `{ clientId, clientSecret }` | `client:manage` |
| `GET /api/oidc/admin/resource-server/list` / `detail` | 资源服务列表 / 详情 | `resource-server:manage` |
| `POST /api/oidc/admin/resource-server/create` / `save` / `set-status` / `remove` | 参数 `identifier`（绝对 URI）、`name`、`scope`、`accessTokenTTL`、`includePermissions`、`description` | `resource-server:manage` |
| `GET /api/oidc/admin/key/list` | 签名密钥列表 `[{ id, kid, alg, status, activatedAt, retiredAt, createdAt }]` | `key:manage` |
| `POST /api/oidc/admin/key/rotate` | 轮换签名密钥 | `key:manage` |
| `GET /api/oidc/admin/session/list?userId=` | 用户 IdP 会话 `[{ uid, loginAt, expiresAt, clients: [{ clientId, sid }] }]` | `session:manage` |
| `POST /api/oidc/admin/session/revoke` | `{ uid }` 结束会话并通知子项目 | `session:manage` |
| `POST /api/oidc/admin/session/revoke-user` | `{ userId, logout = true }` 撤销用户全部令牌，`logout` 时同时强制下线；返回 `{ grants, sessions }` | `session:manage` |
| `GET /api/oidc/admin/app/list` | 子应用列表（`filter.keyword` / `filter.status` / `filter.tenantMode`），每项带 `permissionCount` | `app:manage` |
| `GET /api/oidc/admin/app/detail?id=` | 子应用详情，`permissions` 为子应用上报的权限树 | `app:manage` |
| `POST /api/oidc/admin/app/set-status` | `{ id, status }`，停用后从权限树移除，子应用视为所有租户未开通 | `app:manage` |
| `POST /api/oidc/admin/app/remove` | 删除（状态置为 `removed`）并移除权限来源；列表与详情不再返回；子应用下次启动重新注册即恢复为 `open` | `app:manage` |

子应用只能通过服务接口注册，管理端不提供创建 / 修改。

- 应用停用或删除后，它的 client 登录时没有可用租户，签发的 token 不带租户 claims 与权限（不会回退为宿主未裁剪的权限）；`tenant-list` / `tenant-user` 返回空或 404。
- 已删除的应用编码可以被其他 serviceClient 重新注册接管。
- independent 应用状态变化（停用 / 启用 / 删除 / 删除后重新注册）时，宿主向租户权限中仍有 `apps:<code>` 的租户逐个推送通知，子应用无需等到 `tenantSyncTTL` 即关闭或恢复托管租户。

##### 租户端（standalone 且配置了 `tenant`）

| 接口 | 说明 | 鉴权 |
|------|------|------|
| `GET /api/oidc/tenant/apps` | 当前租户已开通（租户权限含 `apps:<code>`）且启用的子应用 `[{ code, name, description, tenantMode }]`，供宿主租户端应用中心展示；当前租户与 fastify-tenant 的 `tenantUser` 一致（token 中的租户，否则默认租户） | 登录用户 |

##### 服务接口（standalone，client_credentials）

需 `aud` 为 `serviceAudience`、带 `client_token` 标记的 token。

| 接口 | scope | 说明 |
|------|-------|------|
| `GET /api/oidc/service/user?id=` | `user:read` | 用户资料 `{ id, nickname, avatar, avatarUrl, email, phone, gender, birthday, description, status, isSuperAdmin }`；`avatarUrl` 为头像的完整下载地址（经 `fileNamespace` 解析，无文件服务或解析失败时为 `null`） |
| `GET /api/oidc/service/tenant-user?userId=&tenantId=&app=` | `tenant:read` | 用户在租户内的身份、角色、权限（fastify-tenant `getTenantUserInfo` 结果）；传 `app` 时租户未开通该应用返回 404，`permissions` 只含该应用的且去掉 `apps:<app>:` 前缀 |
| `GET /api/oidc/service/tenant-list?userId=&app=` | `tenant:read` | 用户可用租户 `{ list: [{ tenantId, tenantUserId, name, logo, companyName }], defaultTenantId }`；传 `app` 时只含已开通该应用的租户 |
| `POST /api/oidc/service/app/register` | `app:register` | 子应用注册，参数见下；`code` 已被其他 client 注册时返回 403；返回 `{ code, status, permissionsHash, changed }` |
| `GET /api/oidc/service/tenant-snapshot?tenantId=&app=` | `tenant:sync` | 租户快照，见下 |
| `GET /api/oidc/service/tenant-members?tenantId=&app=&currentPage=1&perPage=200` | `tenant:sync` | 成员分页 `{ pageData: [{ id, userId, name, email, phone, avatar, status, roleCodes, tenantOrgIds }], totalCount, fileUrls }`，只含已关联账号的成员；未开通时为空；`fileUrls` 为本页成员头像 `{ 宿主文件 id: 下载地址 }` |

带 `app` 参数的接口只接受注册该应用的 serviceClient 调用，其他 client 返回 403。

`app/register` 参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| code | string | 是 | - | 应用编码 |
| name / description | string | 否 | - | 名称 / 描述 |
| tenantMode | string | 否 | `client` | `client` / `independent` |
| clientId | string | 否 | - | 子应用 SPA 的 client_id，交互时据此只列出已开通的租户 |
| resource | string | 否 | - | 子应用资源服务 identifier，签发 token 时据此裁剪 permissions |
| permissions | object | 否 | `{ modules: [] }` | 权限树，code 不带前缀 |
| tenantSyncUri | string | 否 | - | independent 接收通知的地址 |

`tenant-snapshot` 返回（id 均为宿主侧 id，权限已去前缀）：

```json
{
  "tenant": {
    "id": "t1", "name": "租户 A", "status": "open", "logo": "f-logo", "companyName": "A 公司", "themeColor": "#1677ff", "defaultLanguage": "zh-CN",
    "company": { "name": "A 公司", "fullName": "A 有限公司", "logo": "f-company", "banners": ["f-banner"], "teamDescription": [{ "name": "甲", "avatar": "f-avatar" }], "developmentHistory": [{ "time": "2020-01", "event": "成立", "images": ["f-history"] }] }
  },
  "enabled": true,
  "permissions": ["stock", "stock:view"],
  "roles": [{ "id": "r1", "code": "admin", "name": "管理员", "type": "system", "status": "open", "permissions": ["stock:view"] }],
  "orgs": [{ "id": "o1", "parentId": null, "name": "总部", "index": 0, "status": "open", "leaderTenantUserId": "tu1" }],
  "fileUrls": { "f-logo": "https://host.example.com/api/v1/static/file/xxx.png?filename=logo.png" }
}
```

`enabled` 为 `false`（租户未开通或应用已停用）时 `permissions` / `roles` / `orgs` 为空数组。`logo` 与 `company` 中的图片（`logo`、`banners`、`teamDescription[].avatar`、`developmentHistory[].images`）是宿主文件 id，`fileUrls` 给出它们的下载地址（经 `fileNamespace` 解析，解析失败的不返回）。

宿主租户已被删除时返回 `{ "tenant": { "id": "t1", "status": "closed" }, "enabled": false, "removed": true, "permissions": [], "roles": [], "orgs": [] }`，子应用沿用本地托管租户名将其关闭；本地没有对应托管租户则忽略。

##### Back-Channel Logout（central）

`POST /api/oidc/backchannel-logout`，`application/x-www-form-urlencoded`，参数 `logout_token`。校验通过后撤销 `sid`（无 sid 时按 `sub`），返回 200。

##### 租户变更通知（independent 子应用）

`POST /api/oidc/tenant-sync`，`application/json` 或 `application/x-www-form-urlencoded`，参数 `tenant_sync_token`。校验宿主签名、`aud` 为本应用 serviceClient 的 clientId、`jti` 未使用过后返回 `{}`，并在后台回拉该租户快照。签名错误、过期或重放返回 400。

##### 租户代理（client 子应用，`tenantProxy`）

| 接口 | 说明 |
|------|------|
| `GET /api/tenant/getUserInfo` | `{ userInfo, tenantUserInfo, company, tenant }`，`tenantUserInfo` 来自宿主 `tenant-user`（权限已去前缀） |
| `GET /api/tenant/available-list` | 与 fastify-tenant 同形 `{ list: [{ id, tenantId, status, tenant }], defaultTenantId }`，只含已开通本应用的租户 |
| `* /api/tenant/*` | 以 token exchange 换取宿主 API 令牌后原样转发给宿主 fastify-tenant；只支持 JSON 请求体 |

client 模式切换租户需带 `tenant_id` 重新走授权（租户在 token 中），不能用 `switch-default-tenant`。

#### 程序化 API

##### fastify.oidc.authenticate

| 方法 | 说明 |
|------|------|
| `authenticate.user` | 校验 `Authorization: Bearer / DPoP`（SSE 请求即 `Accept: text/event-stream` 且无该头时，读 query 中的 `Authorization` / `DPoP`，供原生 EventSource 使用），填充 `request.user` 与兼容字段；无 token 且 `legacyToken` 时回退 `x-user-token`；拒绝 client 令牌 |
| `authenticate.tenantUser` | 按 `tenantSource` 填充 `request.tenantUserInfo`；legacy 请求委托给 fastify-tenant |
| `authenticate.admin` | 委托 fastify-account 的超级管理员校验 |
| `authenticate.scope(...scopes)` | 返回中间件，校验 token scope |
| `authenticate.permission(...codes)` | 返回中间件，校验租户权限（`local` / `remote` 实时查询；`claims` 使用 token 中的 permissions） |
| `authenticate.client(...scopes)` | 返回中间件，只接受 `aud` 为 `serviceAudience` 的 client 令牌 |

`request.user` 结构：

| 属性名 | 类型 | 说明 |
|--------|------|------|
| userId | string | 用户 id（`sub`），client 令牌为 `null` |
| tenantId / tenantUserId | string | 当前租户 / 租户用户 id |
| roles | array | 角色 code |
| permissions | array | token 携带的权限，未携带为 `null` |
| clientId | string | 签发 token 的 client |
| scope | array | scope 列表 |
| sid | string | 会话 id |
| actor | string | token exchange 的调用方 client |
| isClient | boolean | 是否 client 令牌 |
| legacy | boolean | 是否来自 `x-user-token` 回退 |
| expiresAt | number | 过期时间（秒） |
| payload | object | 原始 claims |

兼容字段：`request.authenticatePayload = { id, tenantId }`，`request.userInfo` 为 fastify-account 用户（central 为镜像用户）。

central 模式下镜像用户的 `isSuperAdmin` 随主项目同步（升降级均以主项目为准，生效延迟 ≤ `userMirrorTTL`），`authenticate.admin` 仍读本地字段；需配置 `serviceClient`。

central 模式下主项目的 `avatar` 是主项目文件库的 id，子项目无法解析。子项目注册了 fastify-file-manager 时，镜像会按 `avatarUrl` 把头像拷到本地文件库，`avatar` 存本地文件 id（文件记录 `options.oidcAvatarSource` 记来源 id，主项目头像不变不重复下载，变更时原地替换）；主项目未返回 `avatarUrl` 或下载失败时保留已同步的头像，没有则置空。子项目未注册文件服务时 `avatar` 仍为主项目原值。主项目需同时升级才会返回 `avatarUrl`。

##### 其它

| 方法 | 说明 |
|------|------|
| `fastify.oidc.whenReady()` | 等待 IdP 初始化完成（`sequelize.sync()` 之后） |
| `fastify.oidc.onPermissionChange({ userIds, logout = false })` | 撤销用户已签发的令牌，供 fastify-tenant `onPermissionChange` 调用 |
| `fastify.oidc.services.grant.revokeByAccount(userId, { logout })` | 同上，单个用户 |
| `fastify.oidc.services.grant.listSessions({ userId })` / `revokeSession({ uid })` | 会话管理 |
| `fastify.oidc.services.key.rotate()` | 轮换签名密钥并热加载 |
| `fastify.oidc.services.client.*` / `resourceServer.*` | 同管理接口 |
| `fastify.oidc.serviceClient.getServiceToken({ resource, scope })` | client_credentials 取 token（带缓存） |
| `fastify.oidc.serviceClient.getUserProfile(userId)` / `getTenantUser({ userId, tenantId })` | 调主项目服务接口；配置了 `app` 时 `getTenantUser` 自动带 `app` 参数 |
| `fastify.oidc.serviceClient.getTenantList({ userId })` / `registerApp(body)` / `getTenantSnapshot({ tenantId })` / `getTenantMembers({ tenantId, currentPage, perPage })` | 子应用调宿主服务接口，自动带 `app` |
| `fastify.oidc.serviceClient.callService(path, { query, method, body, scope })` | 调宿主任意服务接口，每次只申请传入的 `scope`；失败时 error 带 `upstreamStatus` |
| `fastify.oidc.tenant.getTenantUserInfo({ userId, tenantId })` / `tenantList({ userId })` | client 子应用的租户门面，数据来自宿主，其余模式为 `null` |
| `fastify.oidc.appRegistry.register()` / `whenStarted()` / `getState()` | 子应用手动注册 / 等待启动时的首次注册 / 注册状态 |
| `fastify.oidc.tenantSync.sync(hostTenantId)` / `ensureFresh(hostTenantId)` / `whenIdle(hostTenantId)` | independent 子应用：立即回拉 / 按 `tenantSyncTTL` 回拉并返回本地托管租户 id / 等待进行中的同步 |
| `fastify.oidc.services.app.list()` / `detail()` / `setStatus()` / `remove()` / `register()` | 同管理接口 / 服务接口（standalone） |
| `fastify.oidc.services.tenantPush.push(tenantId)` | 立即通知 independent 子应用回拉该租户（standalone） |
| `fastify.oidc.serviceClient.exchangeToken({ subjectToken, resource, scope })` | Token Exchange |
| `fastify.oidc.revocation.revokeSession(sid)` / `revokeSubject(sub)` / `isRevoked(payload)` | 撤销列表 |
| `fastify.oidc.idp.getProvider()` | oidc-provider 实例（standalone） |

#### 数据模型

以下表只在 standalone 模式创建。

##### payload（`t_oidc_payload`）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| modelName | string | oidc-provider 模型名，如 Session、AccessToken、Grant |
| payloadId | string | oidc-provider 生成的 id |
| payload | JSON | 完整 payload |
| grantId | string | 所属 grant，用于按 grant 撤销 |
| userCode | string | device flow user code |
| uid | string | Session uid |
| accountId | string | 用户 id，用于按用户撤销 / 列出会话 |
| expiresAt | Date | 过期时间 |
| consumedAt | Date | 已使用时间（授权码、轮转后的 refresh token） |

唯一索引 `(model_name, payload_id)`；索引 `grant_id`、`uid`、`user_code`、`(account_id, model_name)`、`expires_at`。

##### client（`t_oidc_client`）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| clientId | string | client_id（唯一） |
| clientName | string | 应用名称 |
| clientSecret | text | 加密存储的 client_secret，public client 为空 |
| metadata | JSON | OIDC client metadata，另支持 `skip_consent`（默认免确认）、`backchannel_logout_uri` 等 |
| allowedResources | JSON | 允许申请的资源服务 identifier |
| description | text | 描述 |
| status | string | `open` / `closed` |

##### resourceServer（`t_oidc_resource_server`）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| identifier | string | 资源标识，即 access_token 的 `aud`（唯一） |
| name | string | 名称 |
| scope | string | 支持的 scope，空格分隔 |
| accessTokenTTL | number | access_token 有效期（秒），为空使用 `ttl.accessToken` |
| includePermissions | boolean | 是否携带 permissions，为空使用 `includePermissions` |
| description | text | 描述 |
| status | string | `open` / `closed` |

##### key（`t_oidc_key`）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| kid | string | JWK kid（唯一） |
| alg | string | 签名算法（RS256） |
| privateJwk | text | 加密存储的私钥 |
| publicJwk | JSON | 公钥 |
| status | string | `active` 当前签名 / `next` 已发布待启用 / `retired` 仅验签 |
| activatedAt / retiredAt | Date | 启用 / 退役时间 |

##### sessionTenant（`t_oidc_session_tenant`）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| sessionUid | string | IdP 会话 uid（唯一） |
| accountId | string | 用户 id |
| tenantId | string | 会话当前租户 |

##### app（`t_oidc_app`）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| code | string | 应用编码（唯一），宿主权限 code 前缀 `apps:<code>` |
| name / description | string | 名称 / 描述 |
| tenantMode | string | `client` / `independent` |
| serviceClientId | string | 首次注册的服务 client_id，之后只有它能更新该应用、读取应用相关数据 |
| clientIds | JSON | 子应用 SPA 的 client_id 列表 |
| resource | string | 子应用资源服务 identifier |
| permissions | JSON | 子应用上报的权限树（不含前缀） |
| permissionsHash | string | 权限树摘要，未变化时不重建宿主权限树 |
| tenantSyncUri | string | independent 接收通知的地址 |
| registeredAt | Date | 最近一次注册时间 |
| status | string | `open` / `closed` |

新表由 `sequelize.sync()` 创建，无需迁移脚本。

#### 机制说明

##### 自定义 adapter（如 Redis）

默认 oidc-provider 的数据存于 `payload` 表。高并发场景可通过 `adapter` 改用 Redis 等存储，插件不内置实现，由业务按以下约定自行编写。Client 始终从 `client` 表读取，不经过 adapter。

`adapter` 为 class（`new Adapter(name)`）或工厂函数（`name => instance`），`name` 为 oidc-provider 模型名：

| 方法 | 说明 |
|------|------|
| `upsert(id, payload, expiresIn)` | 写入，`expiresIn` 秒后过期（映射为 Redis TTL） |
| `find(id)` | 读取，不存在或过期返回 `undefined` |
| `findByUid(uid)` | 按 Session uid 读取（Session 模型） |
| `findByUserCode(userCode)` | device flow，可不实现 |
| `consume(id)` | 标记已使用：payload 写入 `consumed` 秒级时间戳 |
| `destroy(id)` | 删除 |
| `revokeByGrantId(grantId)` | 删除该 grant 下的所有记录 |
| `findGrantIdsByAccountId(accountId)` | **kne 扩展**，Grant 模型调用，返回该用户的 grantId 列表；未实现时无法按用户撤销 |
| `findByAccountId(accountId)` | **kne 扩展**，Session 模型调用，返回该用户的会话 payload；未实现时管理接口无法列出 / 强制下线 |

```js
// 业务项目 libs/oidc-redis-adapter.js（示意，基于 ioredis）
const createRedisAdapter = redis =>
  class RedisAdapter {
    constructor(name) {
      this.name = name;
    }
    key(id) {
      return `oidc:${this.name}:${id}`;
    }
    async upsert(id, payload, expiresIn) {
      const multi = redis.multi();
      multi.set(this.key(id), JSON.stringify(payload), ...(expiresIn ? ['EX', expiresIn] : []));
      if (payload.grantId) {
        // grant 下的所有令牌，用于 revokeByGrantId
        multi.rpush(`oidc:grant:${payload.grantId}`, this.key(id));
        if (expiresIn) multi.expire(`oidc:grant:${payload.grantId}`, expiresIn);
      }
      if (payload.uid) multi.set(`oidc:uid:${payload.uid}`, id, ...(expiresIn ? ['EX', expiresIn] : []));
      if (payload.accountId && ['Grant', 'Session'].includes(this.name)) {
        // kne 扩展：按用户索引 grant / session
        multi.sadd(`oidc:account:${this.name}:${payload.accountId}`, id);
      }
      await multi.exec();
    }
    async find(id) {
      const data = await redis.get(this.key(id));
      return data ? JSON.parse(data) : undefined;
    }
    async findByUid(uid) {
      const id = await redis.get(`oidc:uid:${uid}`);
      return id ? this.find(id) : undefined;
    }
    async consume(id) {
      const payload = await this.find(id);
      if (payload) {
        payload.consumed = Math.floor(Date.now() / 1000);
        await redis.set(this.key(id), JSON.stringify(payload), 'KEEPTTL');
      }
    }
    async destroy(id) {
      await redis.del(this.key(id));
    }
    async revokeByGrantId(grantId) {
      const keys = await redis.lrange(`oidc:grant:${grantId}`, 0, -1);
      await redis.del(...keys, `oidc:grant:${grantId}`);
    }
    async findGrantIdsByAccountId(accountId) {
      const ids = await redis.smembers(`oidc:account:Grant:${accountId}`);
      const alive = await Promise.all(ids.map(id => redis.exists(this.key(id))));
      return ids.filter((id, index) => alive[index]);
    }
    async findByAccountId(accountId) {
      const ids = await redis.smembers(`oidc:account:${this.name}:${accountId}`);
      return (await Promise.all(ids.map(id => this.find(id)))).filter(Boolean);
    }
  };

fastify.register(require('@kne/fastify-oidc'), {
  adapter: createRedisAdapter(fastify.redis)
});
```

> **注意**：账号索引集合（`oidc:account:*`）不会随成员过期自动清理，`findGrantIdsByAccountId` / `findByAccountId` 需过滤已过期的 id，或定期清理。

##### 撤销列表存储

`revocationStore` / `dpopReplayStore` 只需实现两个方法，可直接用 Redis：

| 方法 | 说明 |
|------|------|
| `get(key)` | 返回值或 `undefined` |
| `set(key, value, ttlSeconds)` | 写入并设置过期 |

```js
// 多实例部署：撤销列表与 DPoP 防重放共享
const store = {
  get: async key => (await fastify.redis.get(`oidc:revocation:${key}`)) ?? undefined,
  set: async (key, value, ttl) => fastify.redis.set(`oidc:revocation:${key}`, value, 'EX', ttl)
};
fastify.register(require('@kne/fastify-oidc'), { revocationStore: store, dpopReplayStore: store });
```

##### 签名密钥轮换

| 状态 | 用途 |
|------|------|
| active | 当前签发 token |
| next | 已发布到 JWKS，下次轮换时启用（让各方提前缓存公钥） |
| retired | 只用于验证轮换前签发的 token，超过 `retiredKeyTTL` 后删除 |

`key.rotate()`：active → retired、next → active、生成新 next。其它实例每 `keyReloadInterval` 秒检测密钥指纹变化并重建 provider。

##### Token Exchange

`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`，调用方为已认证的 confidential client，且 `grant_types` 包含该值：

| 参数 | 必填 | 说明 |
|------|------|------|
| subject_token | 是 | 本 IdP 签发的用户 access_token，其 `aud` 必须在调用方 `allowedResources` 中，且未被撤销 |
| subject_token_type | 是 | `urn:ietf:params:oauth:token-type:access_token` |
| resource | 是 | 目标资源，必须在调用方 `allowedResources` 中 |
| scope | 否 | 默认为目标资源全部 scope |

新 token 保留原用户与租户，`act.sub` 为调用方 client_id。

##### 子应用与租户

宿主（standalone 且传入 `tenant`）按 `tenantRole` 区分运行角色：

| tenantRole | 条件 | 说明 |
|------------|------|------|
| host | standalone + `tenant` | 开启应用中心，接收子应用注册，按租户开关子应用 |
| client | central + `app.tenantMode = client` | 租户相关数据全部来自宿主 |
| independent | central + `app.tenantMode = independent` + `tenant` | 本地 fastify-tenant；宿主同步过来的租户由宿主接管，本地自建租户不受影响 |
| none | 其它 | 与之前行为一致 |

```
子应用启动（onReady）
  ↓ POST /service/app/register（失败退避重试）
宿主 oidc_app ─→ tenant.setPermissionSource('oidc-app:<code>', apps → <code> → 权限树, { defaultDisabled: true })
  ↓ 管理员在租户权限中勾选 apps:<code>（即开通）
交互 / 签发 token：子应用 client 只列出已开通的租户；token permissions 只含 apps:<code>: 下的权限并去前缀
  ↓ independent：tenant.onChange（防抖）→ POST tenantSyncUri（tenant_sync_token）
子应用 /api/oidc/tenant-sync → 回拉 tenant-snapshot + tenant-members（分页）→ userMirror.ensure → managed.applySnapshot
```

> **关键设计**：子应用的权限 code 在宿主侧统一加 `apps:<code>:` 前缀，模块 code `apps:<code>` 本身就是租户开关；下发给子应用时去掉前缀，子应用代码仍写自己的 code。新租户默认不开通任何子应用。

independent 模式的同步范围（以宿主为准，全部只读）：

| 内容 | 规则 |
|------|------|
| 租户基本信息与状态 | 名称、主题色、语言、服务期等；宿主关闭或删除租户、取消开通、停用或删除应用时本地托管租户置为 `closed` |
| 租户权限 | 宿主租户在该应用下的权限（去前缀） |
| 角色与角色权限 | 按 code 对应；宿主删除的非系统角色置为 `closed` |
| 组织架构 | 按层级先父后子写入，`parentId`、负责人映射为本地 id；宿主删除的组织置为 `closed` |
| 公司信息 | 全称、logo、行业、banner、团队介绍、发展历程等整体覆盖 |
| 成员 | `userId` 为宿主用户 id（即镜像用户），多组织、角色按映射整体替换；头像优先用宿主租户内的头像，没有时用镜像用户的头像；宿主删除的成员置为 `closed` |

- **图片**：租户 logo、公司信息中的图片、成员头像按宿主给出的地址下载，经 `uploadFromUrl` 存入子应用自己的文件库，写入本地文件 id；`宿主文件 id → 本地文件 id` 记在 `tenant.options.managedBy.files`，宿主文件不变且本地文件仍在时不再下载；下载失败的图片置空，下次同步重试。子应用没有文件库时保留宿主文件 id。
- 托管租户的标记、写拦截和快照写入由 fastify-tenant 提供（`tenant.options.managedBy`、`services.managed.applySnapshot`），子应用不能修改托管租户下的任何数据，也不能在其下补充本地部门或接入第三方组织同步。
- **重名规则**：宿主租户名与子应用本地已有租户重名时，托管租户名追加 `（宿主）` 后缀，仍冲突依次为 `（宿主2）`、`（宿主3）`……；宿主改名后按同样规则重新计算。
- 推送是尽力而为，失败只记日志；服务关闭时会等进行中的推送与同步结束；子应用请求带宿主租户时，本地没有对应托管租户会先同步拉取，已超过 `tenantSyncTTL` 则后台刷新。同一租户的同步串行执行，进行中再收到通知只重跑一次。
- independent 模式下 `request.user.hostTenantId` 为 token 中的宿主租户，`request.user.tenantId` 与 `request.authenticatePayload.tenantId` 由本地默认租户决定（首次同步时为成员设置默认租户），本地没有默认租户时用宿主租户对应的托管租户。
- 交互时子应用 client 只考虑已开通该应用的租户；IdP 会话的当前租户在宿主与子应用之间共享，若会话当前租户未开通该应用且只有一个可用租户，会切换会话租户。

##### 国际化

返回给前端的错误信息、OAuth `error_description`、登出页文案均通过 [@kne/fastify-intl](https://www.npmjs.com/package/@kne/fastify-intl) 按请求语言翻译：

| 场景 | 语言来源 |
|------|------|
| `/api/oidc/*` 接口、`authenticate.*` 钩子 | fastify-intl 的 `getRequestLocale(request)`（query `lang` → cookie / header `x-user-locale` → `accept-language`） |
| `/oidc/*` 协议端点（oidc-provider） | 进入 oidc-provider 前按同样规则解析，存在 `request.raw.kneOidcLocale` |

查找顺序：请求语言 → fastify-intl `defaultLocale` → 内置 `zh-CN`。未注册 fastify-intl 时始终返回内置 `zh-CN`。

内置语言包 `zh-CN`、`en-US` 以命名空间 `locale` 模块挂在 `fastify.oidc.locale`，fastify-intl 会自动以模块名 `oidc` 加载；其它语言可通过 fastify-intl 的 `requestMessages`（模块名 `oidc`）或 fastify-intl-admin 补充，key 与内置语言包一致。

包内抛出的错误带 `messageId` / `messageValues`。业务代码直接调用 `serviceClient` 等方法捕获到错误时，可用 `fastify.oidc.translator.translateError(request, error)` 翻译：

| 方法 | 说明 |
|------|------|
| `fastify.oidc.translator.t(request \| locale, messageId, values)` | 翻译单条文案 |
| `fastify.oidc.translator.translateError(request \| locale, error)` | 有 `messageId` 时按请求语言改写 `error.message` |
| `fastify.oidc.translator.getLocale(request)` | 当前请求语言，未注册 fastify-intl 时为 `null` |

> **注意**：启动期的配置校验错误（如缺少 `ORIGIN`、central 未配置 issuer）面向开发者，不做翻译。
