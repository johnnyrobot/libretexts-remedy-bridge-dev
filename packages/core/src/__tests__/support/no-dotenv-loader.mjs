// Test-only loader: child fixtures never load the developer's environment files.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'dotenv') return {url:'data:text/javascript,export const config=()=>({});',shortCircuit:true};
  if (specifier === 'dotenv/config') return {url:'data:text/javascript,export {};',shortCircuit:true};
  return nextResolve(specifier, context);
}
