import { Remote } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Apply `@Remote` (or `@Remote({ mode: 'stream' })`) to one method without
 * decorator syntax. The decorator only schedules an initializer that records
 * a marker on the instance's prototype, so running that initializer against a
 * bare prototype instance has the same effect as class construction would.
 *
 * Server code runs as type-stripped `.ts`, which has no decorator syntax, so
 * every Typert remote service in this workspace marks its methods this way.
 * @param target - the service class.
 * @param method - the public instance method to expose.
 * @param options - `{ mode: 'stream' }` for an async-generator method.
 */
export function markRemote(target: { prototype: object }, method: string, options?: { mode: 'stream' }): void {
  const decorate = (options === undefined ? Remote : Remote(options)) as (
    value: unknown, context: ClassMethodDecoratorContext) => void
  const initializers: ((this: object) => void)[] = []
  decorate(Reflect.get(target.prototype, method), {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    metadata: {},
    access: { has: object => method in (object as object), get: object => Reflect.get(object as object, method) },
    addInitializer: (initializer) => { initializers.push(initializer as (this: object) => void) },
  } as ClassMethodDecoratorContext)
  const instance = Object.create(target.prototype) as object
  for (const initializer of initializers) initializer.call(instance)
}
