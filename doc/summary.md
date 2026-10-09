### 项目概述

`@kne/fastify-oidc` 基于 [oidc-provider](https://github.com/panva/node-oidc-provider) 为 kne 体系的 Fastify 项目提供 OIDC / OAuth 2.0 认证能力，解决多个业务项目之间的统一登录、租户上下文传递与跨项目调用问题。

同一个插件按 `mode` 扮演两种角色：

| 模式 | 角色 | 说明 |
|------|------|------|
| `standalone` | IdP + 资源服务 | 内嵌 OIDC Provider，账号来自 `@kne/fastify-account`，租户 / 角色 / 权限来自 `@kne/fastify-tenant`；单独部署的项目和"主项目"都用此模式 |
| `central` | 资源服务 + Client | 不启动 IdP、不建 OIDC 表，用主项目的 JWKS 验签，用户在本地 fastify-account 中按 `sub` 建镜像 |

> **关键设计**：业务代码只依赖 `fastify.oidc.authenticate.*` 填充的 `request.user`（以及兼容字段 `request.userInfo` / `request.authenticatePayload` / `request.tenantUserInfo`），从 standalone 切换到 central 只需改环境变量。

### 核心架构与流程

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

### 核心概念详解

#### 资源服务（Resource Server）与 audience

每个需要 access_token 的 API 是一个资源服务，`identifier` 即 token 的 `aud`。默认自动注册：

| 资源 | identifier | scope | 用途 |
|------|------------|-------|------|
| 本项目 API | `${ORIGIN}/api` | `api` | SPA 调用本项目接口 |
| 服务接口 | `${issuer origin}${prefix}` | `user:read tenant:read` | 子项目以 client_credentials 读取用户 / 租户 |

client 只能申请 `allowedResources` 中的资源；子项目 token 的 `aud` 是子项目 API，拿到主项目会被拒绝。

#### 租户上下文

登录后增加一个自定义交互步骤 `tenant`（位于 login 与 consent 之间），选定的租户按 IdP 会话保存：

| 情况 | 行为 |
|------|------|
| 用户不属于任何租户 | 跳过，token 不带租户 claims |
| 只属于一个租户 | 自动选中 |
| 多个租户 | 前端展示租户列表 |
| 授权请求带 `tenant_id` 且用户是成员 | 静默切换（可配合 `prompt=none`） |
| 会话中的租户已不再有效（被移出、关闭） | 重新判断上面几种情况 |

token 中的租户相关 claim 以命名空间为前缀（默认 `${ORIGIN}/`，central 模式为 issuer 的 origin）：`tenant_id`、`tenant_user_id`、`roles`、`permissions`（按资源服务 `includePermissions` 决定是否携带）。

#### 令牌撤销

JWT access_token 无法真正撤销，插件在资源侧维护一个撤销列表：

| 触发 | 撤销方式 |
|------|----------|
| RP-Initiated Logout（standalone） | 会话中各 client 的 `sid` 加入撤销列表 |
| Back-Channel Logout（central） | 子项目收到 logout_token 后撤销 `sid`（无 sid 时按 `sub`） |
| 权限变化 `onPermissionChange` | 撤销该用户所有 grant / refresh token，并拒绝撤销时间之前签发的 token；IdP 会话保留，前端静默重新获取带新权限的 token |
| 管理接口强制下线 | 同上，并结束 IdP 会话、发送 back-channel logout |

> **注意**：撤销列表默认存内存，多实例部署时需通过 `revocationStore` 传入共享存储（见 API 文档）。central 子项目的撤销列表与主项目相互独立，权限变化只在主项目生效，子项目依赖较短的 access_token 有效期（默认 10 分钟）。

### 主要特性

| 特性 | 说明 |
|------|------|
| 授权码 + PKCE | SPA 公共 client，`token_endpoint_auth_method: none` |
| JWT access_token | RS256 签名，`typ: at+jwt`，按资源服务区分 `aud` |
| Refresh Token 轮转 | 每次刷新签发新 refresh token，旧的立即失效 |
| 多租户 | 交互式 / 自动 / 静默切换租户，租户信息写入 token |
| SSO | 多个项目共用主项目 IdP 会话 |
| RP-Initiated Logout / Back-Channel Logout | 登出时通知所有子项目 |
| DPoP | 前端可选启用，token 与浏览器密钥绑定，资源侧校验 proof 与重放 |
| Client Credentials | 服务间调用，token 带 `client_token` 标记，只能访问 `authenticate.client` 保护的接口 |
| Token Exchange（RFC 8693） | 服务端代用户换取访问其它资源服务的 token，token 带 `act` |
| 签名密钥轮换 | active / next / retired 三态，多实例定期检测并热加载 |
| 兼容旧 token | `legacyToken` 开启时，无 `Authorization` 头回退到 fastify-account 的 `x-user-token` |
| 国际化 | 注册 @kne/fastify-intl 后错误信息、协议错误描述、登出页按请求语言返回（内置 `zh-CN` / `en-US`） |

### 使用方法

#### 主项目 / 独立项目（standalone）

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

#### 子项目（central）

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

#### 前端

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

#### 运行环境

oidc-provider 9.x 为 ESM 包，本插件通过动态 `import()` 加载，要求 Node.js `>= 22.12`；在 oidc-provider 未列入支持范围的 Node 版本上启动时会输出 `Unsupported runtime` 警告，不影响运行。
