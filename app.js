import { app } from 'mu';
import bodyParser from 'body-parser';
import { NAMESPACES as ns } from './env';
import * as env from './env';
import { v4 as uuid } from 'uuid';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { isAuthorized } from './config/filter';
//Use `node:buffer` on more modern NodeJS versions
import { Buffer } from 'buffer';
import * as jsonld from 'jsonld';
import * as con from './contexts';
import * as N3 from 'n3';
const { namedNode, literal, blankNode } = N3.DataFactory;

//To make sure SPARQL queries are kept, as a Buffer in this case.
//Other bodyParsers are set in the mu-javascript-template.
app.use(bodyParser.raw({ type: 'application/sparql-query' }));

//Middleware for request checking and authorization.
app.use(async function (req, res, next) {
  try {
    ensureSparqlParams(req);
    const session = namedNode(req.get('Mu-Session-Id'));
    await ensureAuthorized(session);
    next();
  } catch (err) {
    next(err);
  }
});

//When checking and authorization succeeded, just proxy the request.
//We need to intercept the request first to transform the body back to a normal string or the request keeps hanging because it might not look like all data has come through yet.
app.use(
  '/sparql',
  createProxyMiddleware({
    target: env.DATABASE_HOST,
    logLevel: env.PROXY_LOGLEVEL,
    onProxyReq: function (proxyReq, req) {
      const body = req.body;
      if (!body) return;
      const contentType = proxyReq.getHeader('Content-Type');

      if (env.DEFAULT_MU_AUTH_SCOPE) {
        proxyReq.setHeader('mu-auth-scope', env.DEFAULT_MU_AUTH_SCOPE);
      }
      if (/application\/sparql-query/.test(contentType)) {
        proxyReq.setHeader('Content-Length', Buffer.byteLength(body));
        proxyReq.write(body.toString());
      } else {
        //Built-in function of http-proxy-middleware to transform other cases
        fixRequestBody(proxyReq, req);
      }
    },
  }),
);

///////////////////////////////////////////////////////////////////////////////
// Error handler
///////////////////////////////////////////////////////////////////////////////

// For some reason the 'next' parameter is unused and eslint notifies us, but when removed, Express does not use this middleware anymore.
/* eslint-disable no-unused-vars */
app.use(async (err, req, res, next) => {
  if (env.LOGLEVEL === 'error') console.error(err);
  res.status(err.status || 500);
  const errorStore = errorToStore(err);
  const errorJsonld = await storeToJsonLd(
    errorStore,
    con.ErrorResponseContext,
    con.ErrorResponseFrame,
  );
  res.json(errorJsonld);
});
/* eslint-enable no-unused-vars */

///////////////////////////////////////////////////////////////////////////////
// Authorization
///////////////////////////////////////////////////////////////////////////////

/*
 * Check if this session is authorized to send SPARQL requests. This uses the imported `isAuthorized` function from the `filter.js` config files. The function is invoked with the session URI as a string.
 *
 * @async
 * @function
 * @param {NamedNode} session - The session IRI that came as part of the incoming request, based on the client's cookie.
 * @returns {undefined} Nothing
 * @throws {Error} Throws an error if the return of the externally configured authorization function returns a falsy value.
 */
async function ensureAuthorized(session) {
  let isAuth = await isAuthorized(session.value);
  if (!isAuth) {
    const err = new Error(
      'This session is not authorized to execute SPARQL queries.',
    );
    err.status = 403;
    throw err;
  }
}

///////////////////////////////////////////////////////////////////////////////
// Helpers
///////////////////////////////////////////////////////////////////////////////

/*
 * Make sure the incoming request has the content type(s) and other headers fitting for a SPARQL request.
 *
 * @function
 * @param {Request} req - The ExpressJS request that contains the 'Content-Type' and other headers.
 * @returns {undefined} Nothing
 * @throws {Error} Throws an error with a message if at least a required header is missing or a header is unsupported.
 */
function ensureSparqlParams(req) {
  switch (req.method) {
    case 'POST':
      ensurePOSTSparqlParams(req);
      break;
    case 'GET':
      ensureGETSparqlParams(req);
      break;
    default: {
      const err = new Error(
        'Not a correctly formed request for SPARQL queries.',
      );
      err.status = 401;
      throw err;
    }
  }
  if (!req.get('Mu-Session-Id')) {
    const err = new Error(
      'The required "mu-session-id" header could not be found. This is usually attached to the request by the mu-identifier.',
    );
    err.status = 401;
    throw err;
  }
}

/*
 * Check if a POST request for a SPARQL query is correctly formed. This means that if you send a request with Content-Type application/x-www-form-urlencoded, you need to supply the query as a form field, and if you send it as a application/sparql-query, you must send it as the body of the request.
 *
 * @function
 * @param {Request} req - The ExpressJS request with the headers and body that can be checked.
 * @returns {undefined} Nothing
 * @throws {Error} Throws an error if the combination of Content-Type and body structure does not match or any of it is missing.
 */
function ensurePOSTSparqlParams(req) {
  const contentType = req.get('Content-Type');
  if (/application\/x-www-form-urlencoded/.test(contentType)) {
    if (!req.body?.query) {
      const err = new Error(
        'When querying with POST and Content-Type "application/x-www-form-urlencoded", you must supply the query as a form parameter.',
      );
      err.status = 400;
      throw err;
    }
  } else if (/application\/sparql-query/.test(contentType)) {
    if (req.body.toString().trim() === '') {
      const err = new Error(
        'When querying with POST and Content-Type "application/sparql-query", you must supply the query as the body.',
      );
      err.status = 400;
      throw err;
    }
  } else {
    const err = new Error(
      'Content-Type not valid, only "application/x-www-form-urlencoded" or "application/sparql-query" are accepted',
    );
    err.status = 400;
    throw err;
  }
}

/*
 * Check if a GET request for a SPARQL query is correctly formed. This means that you sent a request with the query as a URL parameter named 'query' and an empty request body.
 *
 * @function
 * @param {Request} req - The ExpressJS request with the headers and body that can be checked.
 * @returns {undefined} Nothing
 * @throws {Error} Throws an error if the query is missing or the body is not empty.
 */
function ensureGETSparqlParams(req) {
  if (!req.query.query) {
    throw new Error(
      'When executing a GET request, the query should be supplied as a URL query parameter.',
    );
  }
  if (Object.keys(req.body).length !== 0) {
    throw new Error('When executing a GET request, the body needs to be empty');
  }
}

/*
 * Produces an RDF store with the data to encode an error in the OSLC namespace.
 *
 * @function
 * @param {Error} errorObject - Instance of the standard JavaScript Error class or similar object that has a `message` property.
 * @returns {N3.Store} A new Store with the properties to represent the error.
 */
function errorToStore(errorObject) {
  const store = new N3.Store();
  const error = blankNode(uuid());
  store.addQuad(error, ns.rdf`type`, ns.oslc`Error`);
  store.addQuad(error, ns.mu`uuid`, literal(uuid()));
  store.addQuad(error, ns.oslc`message`, literal(errorObject.message));
  return store;
}

/*
 * Converts an RDF.JS store to a JSON-LD JavaScript Object performing framing and compacting to produce the most human readable result.
 *
 * @async
 * @function
 * @param {N3.Store} store - A store that contains the properties.
 * @param {Object} context - This object is used to compact the JSON-LD object to contain more consice property names and to use namespace prefixes.
 * @param {Object} frame - This object is used to frame the object, i.e. to enforce a specific tree structure in the produced object.
 * @returns {Object} Returns a fully compacted and framed JSON-LD object with the data from the store.
 */
async function storeToJsonLd(store, context, frame) {
  const jsonld1 = await jsonld.default.fromRDF([...store], {});
  const framed = await jsonld.default.frame(jsonld1, frame);
  const compacted = await jsonld.default.compact(framed, context);
  return compacted;
}
