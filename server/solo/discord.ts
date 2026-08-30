export interface DiscordIdentity { id: string; username: string }

export async function exchangeDiscordCode(code: string, clientId: string, clientSecret: string, redirectUri: string): Promise<DiscordIdentity> {
  const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
    method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, signal:AbortSignal.timeout(10000),
    body:new URLSearchParams({grant_type:'authorization_code',code,client_id:clientId,client_secret:clientSecret,redirect_uri:redirectUri}),
  });
  if (!tokenResponse.ok) throw new Error('Discord sign-in could not be completed.');
  const token = await tokenResponse.json() as {access_token?:unknown};
  if (typeof token.access_token !== 'string') throw new Error('Discord did not return a login token.');
  const response = await fetch('https://discord.com/api/v10/users/@me', {
    headers:{authorization:`Bearer ${token.access_token}`}, signal:AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Discord profile could not be verified.');
  const user = await response.json() as {id?:unknown;username?:unknown};
  if (typeof user.id !== 'string' || !/^\d{17,20}$/.test(user.id) || typeof user.username !== 'string') throw new Error('Invalid Discord profile.');
  // Access/refresh tokens are never stored or returned to the browser.
  return {id:user.id,username:user.username};
}
