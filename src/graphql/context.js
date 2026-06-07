// Builds the per-request GraphQL context.
// Decodes the JWT (if present) so resolvers can read `context.user`.

export async function buildContext(request) {
  let user = null;
  try {
    // jwtVerify throws if no/invalid token; that's fine for public queries.
    await request.jwtVerify();
    user = request.user;
  } catch {
    user = null;
  }
  return { user, log: request.log };
}

/** Throw a GraphQL-friendly error if the request is unauthenticated. */
export function assertAuth(context) {
  if (!context.user) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  return context.user;
}

/** Throw if the authenticated user is not in `roles`. */
export function assertRole(context, ...roles) {
  const user = assertAuth(context);
  if (!roles.includes(user.role)) {
    const err = new Error('Forbidden: insufficient role');
    err.statusCode = 403;
    throw err;
  }
  return user;
}
