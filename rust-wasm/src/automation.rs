use crate::{audio_engine::WasmModulationType, graph::ModulationTransformation, traits::PortId};

#[cfg(feature = "wasm")]
use crate::audio_engine::AudioEngine;
#[cfg(feature = "wasm")]
use js_sys::{Float32Array, Object, Reflect};
#[cfg(feature = "wasm")]
use wasm_bindgen::{prelude::*, JsCast, JsValue};

const DEFAULT_FREQUENCY: f32 = 440.0;
const DEFAULT_GAIN: f32 = 1.0;
const DEFAULT_GATE: f32 = 0.0;
const DEFAULT_VELOCITY: f32 = 0.0;

/// Frame of automation data that can be shared between wasm and native hosts.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[derive(Clone, Debug)]
pub struct AutomationFrame {
    num_voices: usize,
    macro_count: usize,
    macro_buffer_len: usize,
    gates: Vec<f32>,
    frequencies: Vec<f32>,
    velocities: Vec<f32>,
    gains: Vec<f32>,
    macro_buffers: Vec<f32>,
}

impl AutomationFrame {
    pub fn with_dimensions(
        num_voices: usize,
        macro_count: usize,
        macro_buffer_len: usize,
    ) -> Self {
        let macro_buffers = vec![0.0; num_voices * macro_count * macro_buffer_len];
        Self {
            num_voices,
            macro_count,
            macro_buffer_len,
            gates: vec![DEFAULT_GATE; num_voices],
            frequencies: vec![DEFAULT_FREQUENCY; num_voices],
            velocities: vec![DEFAULT_VELOCITY; num_voices],
            gains: vec![DEFAULT_GAIN; num_voices],
            macro_buffers,
        }
    }

    pub fn num_voices(&self) -> usize {
        self.num_voices
    }

    pub fn macro_count(&self) -> usize {
        self.macro_count
    }

    pub fn macro_buffer_len(&self) -> usize {
        self.macro_buffer_len
    }

    pub fn gates(&self) -> &[f32] {
        &self.gates
    }

    pub fn frequencies(&self) -> &[f32] {
        &self.frequencies
    }

    pub fn velocities(&self) -> &[f32] {
        &self.velocities
    }

    pub fn gains(&self) -> &[f32] {
        &self.gains
    }

    pub fn macro_buffers(&self) -> &[f32] {
        &self.macro_buffers
    }

    pub fn gates_mut(&mut self) -> &mut [f32] {
        &mut self.gates
    }

    pub fn frequencies_mut(&mut self) -> &mut [f32] {
        &mut self.frequencies
    }

    pub fn velocities_mut(&mut self) -> &mut [f32] {
        &mut self.velocities
    }

    pub fn gains_mut(&mut self) -> &mut [f32] {
        &mut self.gains
    }

    pub fn macro_buffers_mut(&mut self) -> &mut [f32] {
        &mut self.macro_buffers
    }

    pub fn set_voice_values(
        &mut self,
        voice_index: usize,
        gate: f32,
        frequency: f32,
        velocity: f32,
        gain: f32,
    ) {
        if voice_index >= self.num_voices {
            return;
        }
        self.gates[voice_index] = gate;
        self.frequencies[voice_index] = frequency;
        self.velocities[voice_index] = velocity;
        self.gains[voice_index] = gain;
    }

    pub fn set_macro_value(&mut self, voice_index: usize, macro_index: usize, value: f32) {
        if voice_index >= self.num_voices || macro_index >= self.macro_count {
            return;
        }
        let start = self.macro_offset(voice_index, macro_index);
        for slot in self
            .macro_buffers
            .iter_mut()
            .skip(start)
            .take(self.macro_buffer_len)
        {
            *slot = value;
        }
    }

    pub fn macro_slice(&self, voice_index: usize, macro_index: usize) -> &[f32] {
        let start = self.macro_offset(voice_index, macro_index);
        let end = start + self.macro_buffer_len;
        &self.macro_buffers[start..end]
    }

    fn macro_offset(&self, voice_index: usize, macro_index: usize) -> usize {
        (voice_index * self.macro_count + macro_index) * self.macro_buffer_len
    }

    fn reset_defaults(&mut self) {
        self.gates.fill(DEFAULT_GATE);
        self.frequencies.fill(DEFAULT_FREQUENCY);
        self.velocities.fill(DEFAULT_VELOCITY);
        self.gains.fill(DEFAULT_GAIN);
        self.macro_buffers.fill(0.0);
    }

    #[cfg(feature = "wasm")]
    fn read_parameter_scalar(
        &self,
        parameters: &Object,
        key: &str,
        default: f32,
    ) -> Result<f32, JsValue> {
        let value = Reflect::get(parameters, &JsValue::from_str(key))?;
        if value.is_undefined() || value.is_null() {
            return Ok(default);
        }

        if let Some(array) = value.dyn_ref::<Float32Array>() {
            if array.length() == 0 {
                return Ok(default);
            }
            return Ok(array.get_index(0));
        }

        if let Some(number) = value.as_f64() {
            return Ok(number as f32);
        }

        Ok(default)
    }

    #[cfg(feature = "wasm")]
    fn populate_from_js_object(&mut self, parameters: &Object) -> Result<(), JsValue> {
        self.reset_defaults();

        for voice in 0..self.num_voices {
            let gate_key = format!("gate_{}", voice);
            let freq_key = format!("frequency_{}", voice);
            let gain_key = format!("gain_{}", voice);
            let velocity_key = format!("velocity_{}", voice);

            let gate = self.read_parameter_scalar(parameters, &gate_key, DEFAULT_GATE)?;
            let frequency =
                self.read_parameter_scalar(parameters, &freq_key, DEFAULT_FREQUENCY)?;
            let gain = self.read_parameter_scalar(parameters, &gain_key, DEFAULT_GAIN)?;
            let velocity =
                self.read_parameter_scalar(parameters, &velocity_key, DEFAULT_VELOCITY)?;

            self.set_voice_values(voice, gate, frequency, velocity, gain);

            for macro_index in 0..self.macro_count {
                let macro_key = format!("macro_{}_{}", voice, macro_index);
                let value = self.read_parameter_scalar(parameters, &macro_key, 0.0)?;
                self.set_macro_value(voice, macro_index, value);
            }
        }

        Ok(())
    }
}

#[cfg(feature = "wasm")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
impl AutomationFrame {
    #[cfg_attr(feature = "wasm", wasm_bindgen(constructor))]
    pub fn new(num_voices: usize, macro_count: usize, macro_buffer_len: usize) -> AutomationFrame {
        AutomationFrame::with_dimensions(num_voices, macro_count, macro_buffer_len)
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen(js_name = "populateFromParameters"))]
    pub fn populate_from_parameters(&mut self, parameters: &JsValue) -> Result<(), JsValue> {
        let object = parameters
            .dyn_ref::<Object>()
            .ok_or_else(|| JsValue::from_str("Expected parameter map object"))?;
        self.populate_from_js_object(object)
    }
}

#[cfg(feature = "wasm")]
pub(crate) trait ModulationEndpoint {
    fn connect_nodes_adapter(
        &mut self,
        from_node: usize,
        from_port: PortId,
        to_node: usize,
        to_port: PortId,
        amount: f32,
        modulation_type: Option<WasmModulationType>,
        modulation_transform: ModulationTransformation,
    ) -> Result<(), JsValue>;

    fn remove_specific_connection_adapter(
        &mut self,
        from_node: usize,
        to_node: usize,
        to_port: PortId,
    ) -> Result<(), JsValue>;
}

#[cfg(feature = "wasm")]
impl ModulationEndpoint for AudioEngine {
    fn connect_nodes_adapter(
        &mut self,
        from_node: usize,
        from_port: PortId,
        to_node: usize,
        to_port: PortId,
        amount: f32,
        modulation_type: Option<WasmModulationType>,
        modulation_transform: ModulationTransformation,
    ) -> Result<(), JsValue> {
        self.connect_nodes(
            from_node,
            from_port,
            to_node,
            to_port,
            amount,
            modulation_type,
            modulation_transform,
        )
    }

    fn remove_specific_connection_adapter(
        &mut self,
        from_node: usize,
        to_node: usize,
        to_port: PortId,
    ) -> Result<(), JsValue> {
        self.remove_specific_connection(from_node, to_node, to_port)
    }
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectionUpdate {
    pub from_id: usize,
    pub to_id: usize,
    pub target: PortId,
    pub amount: f32,
    pub modulation_transformation: ModulationTransformation,
    pub is_removing: bool,
    pub modulation_type: Option<WasmModulationType>,
}

impl ConnectionUpdate {
    pub fn new(
        from_id: usize,
        to_id: usize,
        target: PortId,
        amount: f32,
        modulation_transformation: ModulationTransformation,
    ) -> Self {
        Self {
            from_id,
            to_id,
            target,
            amount,
            modulation_transformation,
            is_removing: false,
            modulation_type: None,
        }
    }

    pub fn with_modulation_type(mut self, modulation_type: WasmModulationType) -> Self {
        self.modulation_type = Some(modulation_type);
        self
    }

    pub fn mark_removal(mut self) -> Self {
        self.is_removing = true;
        self
    }
}

#[cfg(feature = "wasm")]
fn apply_connection_update_internal<E: ModulationEndpoint>(
    engine: &mut E,
    update: &ConnectionUpdate,
) -> Result<(), JsValue> {
    if update.is_removing {
        engine.remove_specific_connection_adapter(update.from_id, update.to_id, update.target)
    } else {
        let modulation_type = update
            .modulation_type
            .or(Some(WasmModulationType::VCA));
        engine.connect_nodes_adapter(
            update.from_id,
            PortId::AudioOutput0,
            update.to_id,
            update.target,
            update.amount,
            modulation_type,
            update.modulation_transformation,
        )
    }
}

#[cfg(feature = "wasm")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub struct AutomationAdapter {
    frame: AutomationFrame,
}

#[cfg(feature = "wasm")]
impl AutomationAdapter {
    pub fn with_frame(frame: AutomationFrame) -> Self {
        Self { frame }
    }

    pub fn frame_mut(&mut self) -> &mut AutomationFrame {
        &mut self.frame
    }
}

#[cfg(feature = "wasm")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
impl AutomationAdapter {
    #[cfg_attr(feature = "wasm", wasm_bindgen(constructor))]
    pub fn new(num_voices: usize, macro_count: usize, macro_buffer_len: usize) -> AutomationAdapter {
        AutomationAdapter {
            frame: AutomationFrame::with_dimensions(num_voices, macro_count, macro_buffer_len),
        }
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen(js_name = "processBlock"))]
    pub fn process_block(
        &mut self,
        engine: &mut AudioEngine,
        parameters: &JsValue,
        master_gain: f32,
        output_left: &mut [f32],
        output_right: &mut [f32],
    ) -> Result<(), JsValue> {
        self.frame.populate_from_parameters(parameters)?;
        engine.process_with_frame(&self.frame, master_gain, output_left, output_right);
        Ok(())
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen(js_name = "applyConnectionUpdate"))]
    pub fn apply_connection_update(
        &mut self,
        engine: &mut AudioEngine,
        update: &ConnectionUpdate,
    ) -> Result<(), JsValue> {
        apply_connection_update_internal(engine, update)
    }
}

#[cfg(feature = "wasm")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
impl ConnectionUpdate {
    #[cfg_attr(feature = "wasm", wasm_bindgen(constructor))]
    pub fn new_wasm(
        from_id: usize,
        to_id: usize,
        target: PortId,
        amount: f32,
        modulation_transformation: ModulationTransformation,
        is_removing: bool,
        modulation_type: Option<WasmModulationType>,
    ) -> ConnectionUpdate {
        ConnectionUpdate {
            from_id,
            to_id,
            target,
            amount,
            modulation_transformation,
            is_removing,
            modulation_type,
        }
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen(getter, js_name = "fromId"))]
    pub fn from_id(&self) -> usize {
        self.from_id
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen(getter, js_name = "toId"))]
    pub fn to_id(&self) -> usize {
        self.to_id
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen(getter))]
    pub fn target(&self) -> PortId {
        self.target
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen(getter))]
    pub fn amount(&self) -> f32 {
        self.amount
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen(getter, js_name = "modulationTransformation"))]
    pub fn modulation_transformation(&self) -> ModulationTransformation {
        self.modulation_transformation
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen(getter, js_name = "isRemoving"))]
    pub fn is_removing(&self) -> bool {
        self.is_removing
    }

    #[cfg_attr(feature = "wasm", wasm_bindgen(getter, js_name = "modulationType"))]
    pub fn modulation_type(&self) -> Option<WasmModulationType> {
        self.modulation_type
    }
}

#[cfg(feature = "wasm")]
#[cfg_attr(feature = "wasm", wasm_bindgen(js_name = "apply_modulation_update"))]
pub fn apply_connection_update(
    engine: &mut AudioEngine,
    update: &ConnectionUpdate,
) -> Result<(), JsValue> {
    apply_connection_update_internal(engine, update)
}

#[cfg(all(test, feature = "wasm"))]
mod tests {
    use super::*;
    use crate::graph::ModulationTransformation;

    #[test]
    fn macro_expansion_matches_worklet_behavior() {
        let mut frame = AutomationFrame::with_dimensions(2, 4, 8);
        frame.set_voice_values(0, 1.0, 330.0, 0.5, 0.75);
        frame.set_macro_value(0, 0, 0.25);
        frame.set_macro_value(0, 1, 0.5);
        frame.set_macro_value(0, 2, 0.75);
        frame.set_macro_value(0, 3, 1.0);

        let macro_slice = frame.macro_slice(0, 2);
        assert_eq!(macro_slice.len(), 8);
        assert!(macro_slice.iter().all(|&value| (value - 0.75).abs() < 1e-6));

        // Ensure other voices remain at defaults
        assert!(frame.macro_slice(1, 3).iter().all(|&value| value == 0.0));
        assert_eq!(frame.frequencies()[0], 330.0);
        assert_eq!(frame.gains()[0], 0.75);
        assert_eq!(frame.velocities()[0], 0.5);
        assert_eq!(frame.gates()[0], 1.0);
        assert_eq!(frame.frequencies()[1], DEFAULT_FREQUENCY);
        assert_eq!(frame.gains()[1], DEFAULT_GAIN);
    }

    #[derive(Default)]
    struct MockEngine {
        connections: Vec<(
            usize,
            PortId,
            usize,
            PortId,
            f32,
            Option<WasmModulationType>,
            ModulationTransformation,
        )>,
        removals: Vec<(usize, usize, PortId)>,
    }

    impl ModulationEndpoint for MockEngine {
        fn connect_nodes_adapter(
            &mut self,
            from_node: usize,
            from_port: PortId,
            to_node: usize,
            to_port: PortId,
            amount: f32,
            modulation_type: Option<WasmModulationType>,
            modulation_transform: ModulationTransformation,
        ) -> Result<(), JsValue> {
            self.connections.push((
                from_node,
                from_port,
                to_node,
                to_port,
                amount,
                modulation_type,
                modulation_transform,
            ));
            Ok(())
        }

        fn remove_specific_connection_adapter(
            &mut self,
            from_node: usize,
            to_node: usize,
            to_port: PortId,
        ) -> Result<(), JsValue> {
            self.removals.push((from_node, to_node, to_port));
            Ok(())
        }
    }

    #[test]
    fn apply_connection_update_adds_connection_with_defaults() {
        let mut engine = MockEngine::default();
        let update = ConnectionUpdate::new(
            1,
            2,
            PortId::GainMod,
            0.75,
            ModulationTransformation::Square,
        );

        apply_connection_update_internal(&mut engine, &update).unwrap();

        assert_eq!(engine.removals.len(), 0);
        assert_eq!(engine.connections.len(), 1);
        let (from, from_port, to, to_port, amount, modulation_type, transform) =
            engine.connections[0];
        assert_eq!(from, 1);
        assert_eq!(from_port, PortId::AudioOutput0);
        assert_eq!(to, 2);
        assert_eq!(to_port, PortId::GainMod);
        assert_eq!(amount, 0.75);
        assert_eq!(modulation_type, Some(WasmModulationType::VCA));
        assert_eq!(transform, ModulationTransformation::Square);
    }

    #[test]
    fn apply_connection_update_removes_connection() {
        let mut engine = MockEngine::default();
        let update = ConnectionUpdate::new(
            4,
            7,
            PortId::FrequencyMod,
            1.0,
            ModulationTransformation::None,
        )
        .mark_removal();

        apply_connection_update_internal(&mut engine, &update).unwrap();

        assert_eq!(engine.connections.len(), 0);
        assert_eq!(engine.removals.len(), 1);
        let (from, to, target) = engine.removals[0];
        assert_eq!(from, 4);
        assert_eq!(to, 7);
        assert_eq!(target, PortId::FrequencyMod);
    }

    #[test]
    fn apply_connection_update_uses_custom_modulation_type() {
        let mut engine = MockEngine::default();
        let update = ConnectionUpdate::new(
            9,
            12,
            PortId::ResonanceMod,
            0.25,
            ModulationTransformation::Cube,
        )
        .with_modulation_type(WasmModulationType::Bipolar);

        apply_connection_update_internal(&mut engine, &update).unwrap();

        assert_eq!(engine.connections.len(), 1);
        let (_, _, _, _, _, modulation_type, _) = engine.connections[0];
        assert_eq!(modulation_type, Some(WasmModulationType::Bipolar));
    }
}
