// Throttle utility function that guarantees a trailing call.
export function throttle<T extends (...args: unknown[]) => void>(func: T, delay: number): T {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let lastArgs: Parameters<T> | null = null;
    let shouldCallAgain = false;
    return function (...args: Parameters<T>) {
        if (!timeout) {
            func(...args);
            timeout = setTimeout(() => {
                timeout = null;
                if (shouldCallAgain && lastArgs) {
                    func(...lastArgs);
                    shouldCallAgain = false;
                    lastArgs = null;
                }
            }, delay);
        } else {
            shouldCallAgain = true;
            lastArgs = args;
        }
    } as T;
}
