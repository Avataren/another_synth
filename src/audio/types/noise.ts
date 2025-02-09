export enum NoiseType {
    White = 0,
    Pink = 1,
    Brownian = 2
}

export interface NoiseState {
    noiseType: NoiseType;
    cutoff: number;
    gain: number;
    is_enabled: boolean;
}

export interface NoiseUpdate {
    noise_type: NoiseType;
    cutoff: number;
    gain: number;
    enabled: boolean;
}