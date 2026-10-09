const oauth = require('oauth4webapi');

/**
 * 极简 cookie jar：只实现授权流程需要的 name / path / 过期处理
 */
const createBrowser = () => {
  const cookies = new Map();

  const store = (url, response) => {
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(';').map(item => item.trim());
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      const attributes = Object.fromEntries(
        attrs.map(attr => {
          const [key, ...rest] = attr.split('=');
          return [key.toLowerCase(), rest.join('=')];
        })
      );
      const cookiePath = attributes.path || '/';
      const key = `${name};${cookiePath}`;
      const expired = attributes['max-age'] === '0' || (attributes.expires && new Date(attributes.expires) <= new Date());
      if (expired || value === '') {
        cookies.delete(key);
      } else {
        cookies.set(key, { name, value, path: cookiePath });
      }
    }
  };

  const header = url => {
    const { pathname } = new URL(url);
    return [...cookies.values()]
      .filter(cookie => pathname === cookie.path || pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`) || cookie.path === '/')
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');
  };

  const request = async (url, init = {}) => {
    const headers = Object.assign({}, init.headers, { cookie: header(url) });
    const response = await fetch(url, Object.assign({}, init, { headers, redirect: 'manual' }));
    store(url, response);
    return response;
  };

  const json = async (url, body) => {
    const response = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(`${response.status} ${JSON.stringify(data)}`);
      error.statusCode = response.status;
      error.data = data;
      throw error;
    }
    return data;
  };

  return { request, json, cookies };
};

/**
 * 模拟浏览器跟随重定向，遇到前端交互页时交给 onInteraction 处理，直到回到 redirect_uri
 */
const authorize = async ({ browser, url, redirectUri, onInteraction }) => {
  let next = url;
  for (let i = 0; i < 20; i++) {
    if (next.startsWith(redirectUri)) {
      return new URL(next);
    }
    const response = await browser.request(next);
    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`授权流程中断：${response.status} ${next} ${await response.text()}`);
    }
    const target = new URL(location, next);
    if (target.searchParams.has('uid') && target.pathname.endsWith('/oidc-interaction')) {
      next = new URL(await onInteraction(target.searchParams.get('uid'), target), next).toString();
      continue;
    }
    next = target.toString();
  }
  throw new Error('授权流程重定向次数过多');
};

const insecure = { [oauth.allowInsecureRequests]: true };

const discover = async issuer => {
  const issuerUrl = new URL(issuer);
  const response = await oauth.discoveryRequest(issuerUrl, Object.assign({ algorithm: 'oidc' }, insecure));
  return oauth.processDiscoveryResponse(issuerUrl, response);
};

/**
 * 使用 oauth4webapi 走一遍 SPA 的授权码 + PKCE 流程
 */
const login = async ({ as, browser, clientId, redirectUri, resource, scope = 'openid profile offline_access api', extra = {}, onInteraction, DPoP }) => {
  const client = { client_id: clientId };
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const url = new URL(as.authorization_endpoint);
  Object.entries(
    Object.assign(
      {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope,
        state,
        code_challenge: await oauth.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256'
      },
      resource ? { resource } : {},
      extra
    )
  ).forEach(([key, value]) => url.searchParams.set(key, value));

  const callback = await authorize({ browser, url: url.toString(), redirectUri, onInteraction });
  const params = oauth.validateAuthResponse(as, client, callback, state);
  const response = await oauth.authorizationCodeGrantRequest(as, client, oauth.None(), params, redirectUri, codeVerifier, Object.assign({}, insecure, resource ? { additionalParameters: { resource } } : {}, DPoP ? { DPoP } : {}));
  return oauth.processAuthorizationCodeResponse(as, client, response);
};

const refresh = async ({ as, clientId, refreshToken, resource, DPoP }) => {
  const client = { client_id: clientId };
  const response = await oauth.refreshTokenGrantRequest(as, client, oauth.None(), refreshToken, Object.assign({}, insecure, resource ? { additionalParameters: { resource } } : {}, DPoP ? { DPoP } : {}));
  return oauth.processRefreshTokenResponse(as, client, response);
};

const getJson = async (url, token, headers = {}) => {
  const response = await fetch(url, { headers: Object.assign(token ? { authorization: `Bearer ${token}` } : {}, headers) });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

const decodeJwt = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

module.exports = { oauth, insecure, createBrowser, authorize, discover, login, refresh, getJson, decodeJwt };
