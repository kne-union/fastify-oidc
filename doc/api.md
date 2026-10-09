### 配置项

#### 基础

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| name | string | 否 | `oidc` | 命名空间名称，即 `fastify.oidc` |
| prefix | string | 否 | `/api/oidc` | 插件接口前缀（交互、管理、服务接口） |
| dbTableNamePrefix | string | 否 | `t_` | 表名前缀，表名形如 `t_oidc_payload` |
| mode | string | 否 | `AUTH_MODE` 或 `standalone` | `standalone` / `central` |
| origin | string | 是 | `ORIGIN` | 本项目对外 origin |
| issuer | string | central 必填 | `OIDC_ISSUER`；standalone 为 `${origin}${mountPath}` | issuer 必须带路径 |
| mountPath | string | 否 | `/oidc` | standalone 未配置 issuer 时 IdP 的挂载路径 |
| audience | string | 否 | `OIDC_AUDIENCE` 或 `${origin}/api` | 本项目 API 的资源标识，即 access_token 的 `aud` |
| clientId | string | 否 | `OIDC_CLIENT_ID` 或 `${name}-spa` | 本项目 SPA 的 client_id |
| claimNamespace | string | 否 | standalone 为 `${origin}/`，central 为 `${issuer origin}/` | 自定义 claim 前缀 |
| accountNamespace | string | 否 | `account` | fastify-account 命名空间 |
| tenantNamespace | string | 否 | `tenant` | fastify-tenant 命名空间，不存在时不启用租户 |
| intlNamespace | string | 否 | `intl` | @kne/fastify-intl 命名空间，不存在时返回内置中文文案 |

#### IdP（standalone）

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
| selfClient | object | 否 | `{}` | 覆盖默认 SPA client 的 metadata |
| clients | array | 否 | `[]` | 启动时登记的 client（已存在则跳过），字段同管理接口 `client/create`，metadata 直接平铺 |
| resourceServers | array | 否 | `[]` | 启动时登记的资源服务（已存在则跳过） |
| serviceScopes | array | 否 | `['user:read', 'tenant:read']` | 服务接口资源的 scope |
| getAuthenticate | function | 否 | 见下文 | 管理接口鉴权，参数为 `client:manage` / `resource-server:manage` / `key:manage` / `session:manage` |

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

#### 资源侧

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| legacyToken | boolean | 否 | `true` | 无 `Authorization` 头时回退到 fastify-account 的 `x-user-token` |
| requireDPoP | boolean | 否 | `false` | 只接受 DPoP 绑定的 token |
| tenantSource | string | 否 | standalone 且有 fastify-tenant 为 `local`，否则 `claims` | `authenticate.tenantUser` 的数据来源：`local` 实时查本地 fastify-tenant；`claims` 由 token 构造；`remote` 调主项目服务接口 |
| tenantUserContextName | string | 否 | `tenantUserInfo` | 租户用户挂载到 request 上的字段名 |
| revocationStore | object | 否 | 内存 | 撤销列表存储，见「撤销列表存储」 |
| dpopReplayStore | object | 否 | 内存 | DPoP proof 防重放存储，接口同 revocationStore |
| getRequestUrl | function | 否 | `${origin}${request.raw.url}` | 计算 DPoP `htu` 比对用的请求地址 |
| serviceClient | object | 否 | `{ clientId: OIDC_SERVICE_CLIENT_ID, clientSecret: OIDC_SERVICE_CLIENT_SECRET }` | 服务端 client（central 拉取用户资料、远程租户、token exchange） |
| serviceAudience | string | 否 | `${issuer origin}${prefix}` | 服务接口资源标识 |
| idpApiBase | string | 否 | `${issuer origin}${prefix}` | 主项目服务接口地址 |
| jwksUri | string | 否 | `${issuer}/jwks` | central 模式远程 JWKS 地址 |
| userMirrorTTL | number | 否 | `600` | central 模式用户镜像缓存时长（秒） |

### 接口

#### OIDC 协议端点（standalone）

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

#### 前端登录配置（standalone / central）

##### GET /api/oidc/config

免登录，供前端登录页判断是否支持 SSO 以及当前模式（如 components-admin 的 Account 登录页）。只返回公开信息：

```json
{
  "mode": "central",
  "issuer": "https://main.example.com/oidc",
  "clientId": "child-spa",
  "audience": "https://child.example.com/api"
}
```

| 字段 | 说明 |
|------|------|
| mode | `standalone` / `central` |
| issuer | IdP issuer；central 为主项目 issuer |
| clientId | 本项目前端使用的 client_id（`clientId` 配置，默认 `oidc-spa`） |
| audience | 本项目资源服务标识 |

#### 登录交互（standalone）

前端交互页通过以下接口驱动流程，均依赖交互 cookie，需与 IdP 同源调用。成功时返回 `{ redirectTo }`，前端 `window.location` 跳转即可。

##### GET /api/oidc/interaction/{uid}

oidc-provider 的交互地址，303 跳转到 `${ORIGIN}${interactionPage}?uid={uid}`。

##### GET /api/oidc/interaction/{uid}/details

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

##### POST /api/oidc/interaction/{uid}/login

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| type | string | 否 | `email` | `email` / `phone` |
| email / phone | string | 否 | - | 账号 |
| password | string | 是 | - | 与 fastify-account 登录一致（前端 md5） |
| remember | boolean | 否 | `true` | `false` 时 IdP 会话随浏览器关闭失效 |

账号密码错误返回 400；账号状态不是 0 / 1 时返回 `{ status }`（与 fastify-account 登录一致，由前端处理如重置密码）。

##### POST /api/oidc/interaction/{uid}/tenant

参数 `tenantId`（必填）。只能选择当前用户所属且开启的租户。

##### POST /api/oidc/interaction/{uid}/confirm

确认授权（`skip_consent: false` 的 client 才会出现 consent 步骤）。

##### POST /api/oidc/interaction/{uid}/abort

取消登录，client 回调收到 `error=access_denied`。

#### 管理接口（standalone）

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

#### 服务接口（standalone，client_credentials）

需 `aud` 为 `serviceAudience`、带 `client_token` 标记的 token。

| 接口 | scope | 说明 |
|------|-------|------|
| `GET /api/oidc/service/user?id=` | `user:read` | 用户资料 `{ id, nickname, avatar, email, phone, gender, birthday, description, status }` |
| `GET /api/oidc/service/tenant-user?userId=&tenantId=` | `tenant:read` | 用户在租户内的身份、角色、权限（fastify-tenant `getTenantUserInfo` 结果） |

#### Back-Channel Logout（central）

`POST /api/oidc/backchannel-logout`，`application/x-www-form-urlencoded`，参数 `logout_token`。校验通过后撤销 `sid`（无 sid 时按 `sub`），返回 200。

### 程序化 API

#### fastify.oidc.authenticate

| 方法 | 说明 |
|------|------|
| `authenticate.user` | 校验 `Authorization: Bearer / DPoP`，填充 `request.user` 与兼容字段；无 token 且 `legacyToken` 时回退 `x-user-token`；拒绝 client 令牌 |
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

#### 其它

| 方法 | 说明 |
|------|------|
| `fastify.oidc.whenReady()` | 等待 IdP 初始化完成（`sequelize.sync()` 之后） |
| `fastify.oidc.onPermissionChange({ userIds, logout = false })` | 撤销用户已签发的令牌，供 fastify-tenant `onPermissionChange` 调用 |
| `fastify.oidc.services.grant.revokeByAccount(userId, { logout })` | 同上，单个用户 |
| `fastify.oidc.services.grant.listSessions({ userId })` / `revokeSession({ uid })` | 会话管理 |
| `fastify.oidc.services.key.rotate()` | 轮换签名密钥并热加载 |
| `fastify.oidc.services.client.*` / `resourceServer.*` | 同管理接口 |
| `fastify.oidc.serviceClient.getServiceToken({ resource, scope })` | client_credentials 取 token（带缓存） |
| `fastify.oidc.serviceClient.getUserProfile(userId)` / `getTenantUser({ userId, tenantId })` | 调主项目服务接口 |
| `fastify.oidc.serviceClient.exchangeToken({ subjectToken, resource, scope })` | Token Exchange |
| `fastify.oidc.revocation.revokeSession(sid)` / `revokeSubject(sub)` / `isRevoked(payload)` | 撤销列表 |
| `fastify.oidc.idp.getProvider()` | oidc-provider 实例（standalone） |

### 数据模型

以下表只在 standalone 模式创建。

#### payload（`t_oidc_payload`）

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

#### client（`t_oidc_client`）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| clientId | string | client_id（唯一） |
| clientName | string | 应用名称 |
| clientSecret | text | 加密存储的 client_secret，public client 为空 |
| metadata | JSON | OIDC client metadata，另支持 `skip_consent`（默认免确认）、`backchannel_logout_uri` 等 |
| allowedResources | JSON | 允许申请的资源服务 identifier |
| description | text | 描述 |
| status | string | `open` / `closed` |

#### resourceServer（`t_oidc_resource_server`）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| identifier | string | 资源标识，即 access_token 的 `aud`（唯一） |
| name | string | 名称 |
| scope | string | 支持的 scope，空格分隔 |
| accessTokenTTL | number | access_token 有效期（秒），为空使用 `ttl.accessToken` |
| includePermissions | boolean | 是否携带 permissions，为空使用 `includePermissions` |
| description | text | 描述 |
| status | string | `open` / `closed` |

#### key（`t_oidc_key`）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| kid | string | JWK kid（唯一） |
| alg | string | 签名算法（RS256） |
| privateJwk | text | 加密存储的私钥 |
| publicJwk | JSON | 公钥 |
| status | string | `active` 当前签名 / `next` 已发布待启用 / `retired` 仅验签 |
| activatedAt / retiredAt | Date | 启用 / 退役时间 |

#### sessionTenant（`t_oidc_session_tenant`）

| 属性名 | 类型 | 说明 |
|--------|------|------|
| sessionUid | string | IdP 会话 uid（唯一） |
| accountId | string | 用户 id |
| tenantId | string | 会话当前租户 |

### 机制说明

#### 自定义 adapter（如 Redis）

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

#### 撤销列表存储

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

#### 签名密钥轮换

| 状态 | 用途 |
|------|------|
| active | 当前签发 token |
| next | 已发布到 JWKS，下次轮换时启用（让各方提前缓存公钥） |
| retired | 只用于验证轮换前签发的 token，超过 `retiredKeyTTL` 后删除 |

`key.rotate()`：active → retired、next → active、生成新 next。其它实例每 `keyReloadInterval` 秒检测密钥指纹变化并重建 provider。

#### Token Exchange

`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`，调用方为已认证的 confidential client，且 `grant_types` 包含该值：

| 参数 | 必填 | 说明 |
|------|------|------|
| subject_token | 是 | 本 IdP 签发的用户 access_token，其 `aud` 必须在调用方 `allowedResources` 中，且未被撤销 |
| subject_token_type | 是 | `urn:ietf:params:oauth:token-type:access_token` |
| resource | 是 | 目标资源，必须在调用方 `allowedResources` 中 |
| scope | 否 | 默认为目标资源全部 scope |

新 token 保留原用户与租户，`act.sub` 为调用方 client_id。

#### 国际化

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
