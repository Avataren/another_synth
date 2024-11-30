export enum FilterType {
    SinglePoleLowPass = 1,
    LowPass = 2,
    HighPass = 3,
    Notch = 4
}

export default class BiQuadFilter {
    private y1: number = 0;
    private y2: number = 0;
    private x1: number = 0;
    private x2: number = 0;
    private s1: number = 0;
    private s2: number = 0;
    private coeffs = {
        a1: 0,
        a2: 0,
        b0: 0,
        b1: 0,
        b2: 0
    };

    process(input: number): number {
        const out = this.coeffs.b0 * input + this.coeffs.b1 * this.x1 + this.coeffs.b2 * this.x2
            - this.coeffs.a1 * this.y1
            - this.coeffs.a2 * this.y2;

        this.x2 = this.x1;
        this.x1 = input;
        this.y2 = this.y1;
        this.y1 = out;

        return out;
    }

    clearBuffers(): void {
        this.y1 = 0;
        this.y2 = 0;
        this.x1 = 0;
        this.x2 = 0;
        this.s1 = 0;
        this.s2 = 0;
    }

    updateCoefficients(
        filtertype: FilterType,
        fsHertz: number,
        f0Hertz: number,
        q_value: number
    ): void {
        const fLimit = (fsHertz / 2.0) - 1000;
        if (f0Hertz > fLimit) {
            f0Hertz = fLimit;
        }

        if (q_value < 0.0) {
            q_value = 0;
        }

        const omega = 2.0 * Math.PI * f0Hertz / fsHertz;
        const omega_s = Math.sin(omega);
        const omega_c = Math.cos(omega);
        const alpha = omega_s / (2.0 * q_value);

        let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;

        switch (filtertype) {
            case FilterType.LowPass:
                b0 = (1.0 - omega_c) * 0.5;
                b1 = 1.0 - omega_c;
                b2 = (1.0 - omega_c) * 0.5;
                a0 = 1.0 + alpha;
                a1 = -2.0 * omega_c;
                a2 = 1.0 - alpha;
                break;
            case FilterType.HighPass:
                b0 = (1.0 + omega_c) * 0.5;
                b1 = -(1.0 + omega_c);
                b2 = (1.0 + omega_c) * 0.5;
                a0 = 1.0 + alpha;
                a1 = -2.0 * omega_c;
                a2 = 1.0 - alpha;
                break;
            default:
                return;
        }

        this.coeffs.a1 = a1 / a0;
        this.coeffs.a2 = a2 / a0;
        this.coeffs.b0 = b0 / a0;
        this.coeffs.b1 = b1 / a0;
        this.coeffs.b2 = b2 / a0;
    }
}
