const fp = require('fastify-plugin');
const { str, any, obj, success } = require('../schema/response');

module.exports = fp(async (fastify, options) => {
  const { services, translator } = fastify[options.name];
  if (!options.runtime.idpEnabled) {
    return;
  }
  const { wrap } = translator;
  const base = `${options.prefix}/interaction/:uid`;
  const params = { type: 'object', required: ['uid'], properties: { uid: { type: 'string', description: '交互 uid（oidc-provider 跳转到登录交互页时带上的 uid）' } } };
  const tags = ['OIDC-登录交互'];
  const HINT = '依赖浏览器携带的 oidc-provider 交互 cookie；交互过期或 uid 不匹配返回 400';
  const redirect = description => success(description, { type: 'object', properties: { redirectTo: str('前端需要跳转的地址（回到授权端点继续流程）') } });

  fastify.get(
    base,
    {
      schema: { tags, summary: '交互入口，跳转到前端登录交互页', description: '303 重定向到前端交互页（interactionPage?uid=<uid>），不返回 JSON', params }
    },
    async (request, reply) => {
      const target = new URL(options.interactionPage, options.runtime.origin);
      target.searchParams.set('uid', request.params.uid);
      return reply.redirect(target.toString(), 303);
    }
  );

  fastify.get(
    `${base}/details`,
    {
      schema: {
        tags,
        summary: '获取当前交互详情（步骤、client、用户、可选租户）',
        description: HINT,
        params,
        response: success('交互详情', {
          type: 'object',
          additionalProperties: true,
          properties: {
            uid: str('交互 uid'),
            prompt: obj('当前步骤', {
              name: str('步骤：login 登录，tenant 选择租户，mfa 多因素认证（短信），consent 确认授权'),
              reasons: any('需要该步骤的原因'),
              details: any('步骤详情（如缺少的 scope）')
            }),
            params: obj('授权请求参数', {
              clientId: str('client_id'),
              scope: str('申请的 scope'),
              resource: any('申请的资源服务'),
              tenantId: str('指定的租户 ID'),
              loginHint: str('登录提示'),
              uiLocales: str('界面语言')
            }),
            client: obj('发起授权的 client，不存在时为 null', {
              clientId: str('client_id'),
              clientName: str('应用名称'),
              logoUri: str('logo 地址'),
              clientUri: str('应用主页')
            }),
            user: obj('已登录用户，未登录时为 null', {
              id: str('用户 ID'),
              nickname: str('昵称'),
              avatar: any('头像文件 ID'),
              email: str('邮箱'),
              phone: str('手机号')
            }),
            tenants: obj('可选租户（仅 tenant 步骤返回，否则为 null）：{ list, defaultTenantId }'),
            mfa: obj('多因素认证信息（仅 mfa 步骤返回）', {
              method: str('验证方式，目前固定为 sms'),
              tenantId: str('要求验证的租户 ID'),
              maxAge: any('租户配置的 MFA 有效期（秒）'),
              phoneMissing: any('账号没有手机号时为 true，此时无法完成验证，调用 mfa/send 会以 access_denied 结束交互'),
              phoneMasked: str('脱敏手机号'),
              resendAfter: any('距离可以重新发送验证码的秒数，0 表示可以发送')
            })
          }
        })
      }
    },
    wrap(async (request, reply) => services.interaction.details({ request, reply, uid: request.params.uid }))
  );

  fastify.post(
    `${base}/login`,
    {
      schema: {
        tags,
        summary: '账号密码登录',
        description: `仅 login 步骤可调用，${HINT}。账号状态不允许登录时只返回 status，否则返回 redirectTo`,
        params,
        body: {
          type: 'object',
          required: ['password'],
          properties: {
            type: { type: 'string', enum: ['email', 'phone'], default: 'email', description: '登录方式：email 邮箱（默认），phone 手机号' },
            email: { type: 'string', description: '邮箱，type=email 时必填' },
            phone: { type: 'string', description: '手机号，type=phone 时必填' },
            password: { type: 'string', description: '密码' },
            remember: { type: 'boolean', default: true, description: '是否保持登录（持久会话 cookie），默认 true' }
          }
        },
        response: success('登录结果', {
          type: 'object',
          properties: {
            redirectTo: str('登录成功后前端需要跳转的地址'),
            status: any('账号状态，仅在账号不允许登录（如未激活、已禁用）时返回')
          }
        })
      }
    },
    wrap(async (request, reply) => {
      const { remember, ...credentials } = request.body;
      return services.interaction.login({ request, reply, uid: request.params.uid, credentials, remember });
    })
  );

  fastify.post(
    `${base}/tenant`,
    {
      schema: {
        tags,
        summary: '选择租户',
        description: `仅 tenant 步骤可调用，${HINT}。租户不在用户可用列表中返回 400`,
        params,
        body: { type: 'object', required: ['tenantId'], properties: { tenantId: { type: 'string', description: '选择的租户 ID（来自交互详情的 tenants.list）' } } },
        response: redirect('选择成功')
      }
    },
    wrap(async (request, reply) => services.interaction.selectTenant({ request, reply, uid: request.params.uid, tenantId: request.body.tenantId }))
  );

  fastify.post(
    `${base}/mfa/send`,
    {
      schema: {
        tags,
        summary: '发送 MFA 短信验证码',
        description: `仅 mfa 步骤可调用，${HINT}。验证码发到账号绑定的手机号，只在本次交互内有效；发送间隔内重复调用返回 400。账号没有手机号时以 access_denied 结束交互并返回 redirectTo`,
        params,
        response: success('发送结果', {
          type: 'object',
          properties: {
            phoneMasked: str('脱敏手机号'),
            expiresIn: any('验证码有效期（秒）'),
            resendAfter: any('距离可以重新发送的秒数'),
            redirectTo: str('账号没有手机号、交互已结束时前端需要跳转的地址')
          }
        })
      }
    },
    wrap(async (request, reply) => services.interaction.mfaSend({ request, reply, uid: request.params.uid }))
  );

  fastify.post(
    `${base}/mfa/verify`,
    {
      schema: {
        tags,
        summary: '校验 MFA 短信验证码',
        description: `仅 mfa 步骤可调用，${HINT}。验证码错误、过期或错误次数过多返回 400，错误次数过多后需重新发送；通过后返回 redirectTo，id_token 的 amr 会包含 sms、mfa`,
        params,
        body: { type: 'object', required: ['code'], properties: { code: { type: 'string', description: '短信验证码' } } },
        response: redirect('验证通过')
      }
    },
    wrap(async (request, reply) => services.interaction.mfaVerify({ request, reply, uid: request.params.uid, code: request.body.code }))
  );

  fastify.post(
    `${base}/confirm`,
    {
      schema: { tags, summary: '确认授权（consent）', description: `仅 consent 步骤可调用，${HINT}。授予本次申请缺少的 scope 与资源权限`, params, response: redirect('授权成功') }
    },
    wrap(async (request, reply) => services.interaction.confirm({ request, reply, uid: request.params.uid }))
  );

  fastify.post(
    `${base}/abort`,
    {
      schema: { tags, summary: '取消登录', description: `${HINT}。以 access_denied 结束授权流程，client 会收到错误回调`, params, response: redirect('已取消') }
    },
    wrap(async (request, reply) => services.interaction.abort({ request, reply, uid: request.params.uid }))
  );
});
