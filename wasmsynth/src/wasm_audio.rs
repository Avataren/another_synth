use crate::dependent_module;
use crate::oscillator::{Oscillator, Params};
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;
use web_sys::{AudioContext, AudioNode, AudioWorkletNode, AudioWorkletNodeOptions};

#[wasm_bindgen]
pub struct WasmAudioProcessor(Box<dyn FnMut(&mut [f32]) -> bool>);

#[wasm_bindgen]
impl WasmAudioProcessor {
    pub fn process(&mut self, buf: &mut [f32]) -> bool {
        self.0(buf)
    }

    pub fn pack(self) -> usize {
        Box::into_raw(Box::new(self)) as usize
    }

    pub unsafe fn unpack(val: usize) -> Self {
        *Box::from_raw(val as *mut Self)
    }
}

#[wasm_bindgen]
pub struct WasmAudio {
    node: AudioWorkletNode,
    _params: Rc<Params>, // Use Rc to manage shared ownership
}

#[wasm_bindgen]
impl WasmAudio {
    pub async fn new(context: &AudioContext) -> Result<WasmAudio, JsValue> {
        let params = Rc::new(Params::default()); // Create Rc for shared ownership
        let osc = RefCell::new(Oscillator::new(params.clone())); // Pass Rc to Oscillator

        prepare_wasm_audio(context).await?;

        let processor = WasmAudioProcessor(Box::new(move |buf| osc.borrow_mut().process(buf)));

        let options = AudioWorkletNodeOptions::new();
        options.set_processor_options(Some(&js_sys::Array::of3(
            &wasm_bindgen::module(),
            &wasm_bindgen::memory(),
            &processor.pack().into(),
        )));

        let node = AudioWorkletNode::new_with_options(context, "WasmProcessor", &options)?;

        Ok(WasmAudio {
            node,
            _params: params, // Store the original Rc
        })
    }

    #[wasm_bindgen]
    pub fn get_node(&self) -> AudioWorkletNode {
        self.node.clone()
    }

    pub fn connect_to_destination(&self) -> Result<(), JsValue> {
        self.node
            .connect_with_audio_node(&self.node.context().destination())?;
        Ok(())
    }

    pub fn connect(&self, destination: &AudioNode) -> Result<(), JsValue> {
        self.node.connect_with_audio_node(destination)?;
        Ok(())
    }

    pub fn set_frequency(&self, value: u8) {
        self._params.set_frequency(value);
    }

    pub fn set_volume(&self, value: u8) {
        self._params.set_volume(value);
    }
}

async fn prepare_wasm_audio(ctx: &AudioContext) -> Result<(), JsValue> {
    let mod_url = dependent_module!("worklet.js")?;
    JsFuture::from(ctx.audio_worklet()?.add_module(&mod_url)?).await?;
    Ok(())
}
