// Shared patch loading logic for both native and wasm builds

use crate::audio_engine::patch::{PatchConnection, VoiceLayout as PatchVoiceLayout};
use crate::graph::{Connection, ModulationTransformation, ModulationType, NodeId};
use crate::biquad::FilterType;
use crate::traits::PortId;
use uuid::Uuid;

/// Result type that can be adapted for different error types
pub type PatchLoaderResult<T> = Result<T, String>;

/// Parse a node ID string as a UUID
pub fn parse_node_id(id_str: &str) -> PatchLoaderResult<NodeId> {
    Uuid::parse_str(id_str)
        .map(NodeId)
        .map_err(|e| format!("Invalid node UUID '{}': {}", id_str, e))
}

/// Parse a port ID from u32
pub fn port_id_from_u32(value: u32) -> PortId {
    PortId::from_u32(value)
}

/// Parse modulation type from i32
pub fn modulation_type_from_i32(value: i32) -> ModulationType {
    ModulationType::from_i32(value)
}

/// Parse modulation transformation from i32
pub fn modulation_transform_from_i32(value: i32) -> ModulationTransformation {
    ModulationTransformation::from_i32(value)
}

/// Parse filter type from i32
pub fn filter_type_from_i32(value: i32) -> FilterType {
    match value {
        0 => FilterType::LowPass,
        1 => FilterType::HighPass,
        2 => FilterType::BandPass,
        3 => FilterType::Notch,
        4 => FilterType::Peaking,
        5 => FilterType::LowShelf,
        6 => FilterType::HighShelf,
        7 => FilterType::Comb,
        _ => FilterType::LowPass,
    }
}

/// Convert PatchConnection to Connection
pub fn patch_connection_to_connection(
    conn: &PatchConnection,
    default_from_port: PortId,
) -> PatchLoaderResult<Connection> {
    let from_node = parse_node_id(&conn.from_id)?;
    let to_node = parse_node_id(&conn.to_id)?;
    let to_port = port_id_from_u32(conn.target);
    let modulation_type = modulation_type_from_i32(conn.modulation_type);
    let modulation_transform = modulation_transform_from_i32(conn.modulation_transform);

    Ok(Connection {
        from_node,
        from_port: default_from_port,
        to_node,
        to_port,
        amount: conn.amount,
        modulation_type,
        modulation_transform,
    })
}

/// Find the first node ID of a specific type in the voice layout
pub fn find_node_id(voice_layout: &PatchVoiceLayout, node_type: &str) -> Option<String> {
    voice_layout
        .nodes
        .get(node_type)
        .and_then(|nodes| nodes.first())
        .map(|node| node.id.clone())
}

/// Parse audio asset ID to extract node type and node ID
pub fn parse_audio_asset_id(asset_id: &str) -> Option<(String, String)> {
    // Expected formats:
    // - "sample_<node_id>" for sampler samples
    // - "impulse_response_<effect_id>" for convolver impulse responses
    // - "wavetable_<node_id>" for wavetable data

    if let Some(node_id) = asset_id.strip_prefix("sample_") {
        return Some(("sample".to_string(), node_id.to_string()));
    }

    if let Some(effect_id) = asset_id.strip_prefix("impulse_response_") {
        return Some(("impulse_response".to_string(), effect_id.to_string()));
    }

    if let Some(node_id) = asset_id.strip_prefix("wavetable_") {
        return Some(("wavetable".to_string(), node_id.to_string()));
    }

    None
}

/// Node creation order - ensures dependencies are created first
pub const NODE_CREATION_ORDER: [&str; 12] = [
    "global_frequency",
    "global_velocity",
    "gatemixer",
    "mixer",
    "filter",
    "oscillator",
    "wavetable_oscillator",
    "sampler",
    "envelope",
    "lfo",
    "noise",
    "arpeggiator_generator",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_audio_asset_id() {
        assert_eq!(
            parse_audio_asset_id("sample_abc123"),
            Some(("sample".to_string(), "abc123".to_string()))
        );

        assert_eq!(
            parse_audio_asset_id("impulse_response_10003"),
            Some(("impulse_response".to_string(), "10003".to_string()))
        );

        assert_eq!(
            parse_audio_asset_id("wavetable_xyz789"),
            Some(("wavetable".to_string(), "xyz789".to_string()))
        );

        assert_eq!(parse_audio_asset_id("invalid"), None);
    }

    #[test]
    fn test_parse_node_id() {
        let valid_uuid = "e3957b9b-9e2d-5999-bc84-93c4cd9d31b5";
        assert!(parse_node_id(valid_uuid).is_ok());

        let invalid_uuid = "not-a-uuid";
        assert!(parse_node_id(invalid_uuid).is_err());
    }
}
