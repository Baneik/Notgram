use image::{ImageDecoder, ImageReader, imageops::FilterType};
use std::{
    collections::VecDeque,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::SystemTime,
};

const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_ENTRIES: usize = 128;
pub(super) const MAX_EDGE: u32 = 1600;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Size {
    pub width: u32,
    pub height: u32,
    pub cover: bool,
}

#[derive(PartialEq, Eq)]
struct Key {
    path: PathBuf,
    modified: SystemTime,
    bytes: u64,
    generation: u64,
    size: Size,
}

pub(super) struct Preview {
    pub png: Vec<u8>,
    pub source_width: u32,
    pub source_height: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Default)]
pub(super) struct PhotoPreviews {
    entries: Mutex<VecDeque<(Key, Arc<Preview>)>>,
    // Serialize cold decodes without holding the cache lock during account reset.
    decoder: Mutex<()>,
    epoch: AtomicU64,
}

impl PhotoPreviews {
    pub fn clear(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            self.epoch.fetch_add(1, Ordering::SeqCst);
            entries.clear();
        }
    }

    pub fn get(
        &self,
        path: &Path,
        size: Size,
        generation: u64,
        is_current: impl Fn() -> bool,
    ) -> Result<(Arc<Preview>, bool), String> {
        let epoch = self.epoch.load(Ordering::SeqCst);
        let is_current = || is_current() && epoch == self.epoch.load(Ordering::SeqCst);
        let metadata = path.metadata().map_err(|error| error.to_string())?;
        let key = Key {
            path: path.to_owned(),
            modified: metadata.modified().map_err(|error| error.to_string())?,
            bytes: metadata.len(),
            generation,
            size,
        };
        let find = || -> Result<Option<Arc<Preview>>, String> {
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| "Preview cache unavailable")?;
            Ok(entries
                .iter()
                .position(|(candidate, _)| candidate == &key)
                .map(|index| {
                    let entry = entries.remove(index).unwrap();
                    let preview = entry.1.clone();
                    entries.push_back(entry);
                    preview
                }))
        };
        if let Some(preview) = find()? {
            return Ok((preview, true));
        }
        let _decoder = self
            .decoder
            .lock()
            .map_err(|_| "Preview decoder unavailable")?;
        if !is_current() {
            return Err("Asset session expired".into());
        }
        if let Some(preview) = find()? {
            return Ok((preview, true));
        }
        let preview = Arc::new(render(path, size)?);
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Preview cache unavailable")?;
        // Check under the cache lock so cleanup cannot be followed by a late insertion.
        if !is_current() {
            return Err("Asset session expired".into());
        }
        entries.push_back((key, preview.clone()));
        let mut bytes: usize = entries.iter().map(|(_, item)| cost(item)).sum();
        while entries.len() > MAX_ENTRIES || bytes > MAX_BYTES {
            if let Some((_, item)) = entries.pop_front() {
                bytes -= cost(&item);
            }
        }
        Ok((preview, false))
    }
}

fn cost(preview: &Preview) -> usize {
    preview.png.len() + preview.width as usize * preview.height as usize * 4
}

pub(super) fn parse_size(query: &str) -> Result<Size, String> {
    let mut width = None;
    let mut height = None;
    let mut cover = None;
    for pair in query.split('&') {
        match pair.split_once('=') {
            Some(("width", value)) if width.is_none() => {
                width = Some(value.parse::<u32>().map_err(|_| "Invalid preview width")?)
            }
            Some(("height", value)) if height.is_none() => {
                height = Some(value.parse::<u32>().map_err(|_| "Invalid preview height")?)
            }
            Some(("fit", "cover")) if cover.is_none() => cover = Some(true),
            Some(("fit", "contain")) if cover.is_none() => cover = Some(false),
            _ => return Err("Invalid photo preview request".into()),
        }
    }
    match (width, height, cover) {
        (Some(width @ 1..=MAX_EDGE), Some(height @ 1..=MAX_EDGE), Some(cover)) => Ok(Size {
            width,
            height,
            cover,
        }),
        _ => Err("Invalid photo preview dimensions".into()),
    }
}

fn render(path: &Path, size: Size) -> Result<Preview, String> {
    if path.metadata().map_err(|error| error.to_string())?.len() > 64 * 1024 * 1024 {
        return Err("Photo preview source is too large".into());
    }
    let mut reader = ImageReader::open(path)
        .map_err(|error| error.to_string())?
        .with_guessed_format()
        .map_err(|error| error.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|error| error.to_string())?;
    let orientation = decoder.orientation().map_err(|error| error.to_string())?;
    let mut image =
        image::DynamicImage::from_decoder(decoder).map_err(|error| error.to_string())?;
    image.apply_orientation(orientation);
    let (source_width, source_height) = (image.width(), image.height());
    // Triangle integrates the source footprint when shrinking, avoiding sharp
    // ringing and undersampled fine patterns. Viewer originals remain untouched.
    let resized = if size.cover {
        // Crop before resizing: a very tall document must not create an
        // enormous intermediate bitmap just to cover a small album tile.
        let ratio = size.width as f64 / size.height as f64;
        let crop_width = source_width.min((source_height as f64 * ratio).round().max(1.0) as u32);
        let crop_height = source_height.min((source_width as f64 / ratio).round().max(1.0) as u32);
        image
            .crop_imm(
                (source_width - crop_width) / 2,
                (source_height - crop_height) / 2,
                crop_width,
                crop_height,
            )
            .resize_exact(size.width, size.height, FilterType::Triangle)
    } else {
        image.resize(size.width, size.height, FilterType::Triangle)
    };
    let (width, height) = (resized.width(), resized.height());
    let mut png = Cursor::new(Vec::new());
    resized
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    Ok(Preview {
        png: png.into_inner(),
        source_width,
        source_height,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_dimensions_and_fields_are_bounded() {
        assert!(parse_size("width=390&height=260&fit=contain").is_ok());
        for query in [
            "width=0&height=1&fit=cover",
            "width=1601&height=1&fit=cover",
            "width=1&height=1&fit=other",
            "width=1&width=2&height=1&fit=cover",
            "width=1&height=1&fit=cover&path=other",
            "width=1&height=1",
            "width=bad&width=1&height=1&fit=cover",
        ] {
            assert!(parse_size(query).is_err(), "{query}");
        }
    }

    #[test]
    fn downsampling_filters_fine_detail_and_preserves_original_dimensions() {
        let path =
            std::env::temp_dir().join(format!("notgram-photo-preview-{}.png", std::process::id()));
        let image = image::RgbImage::from_fn(2048, 1024, |x, y| {
            let value = if (x + y) % 2 == 0 { 0 } else { 255 };
            image::Rgb([value; 3])
        });
        image.save(&path).unwrap();
        let previews = PhotoPreviews::default();
        let size = Size {
            width: 390,
            height: 195,
            cover: false,
        };
        let (preview, cached) = previews.get(&path, size, 1, || true).unwrap();
        assert!(!cached);
        assert_eq!((preview.source_width, preview.source_height), (2048, 1024));
        assert_eq!((preview.width, preview.height), (390, 195));
        let pixels = image::load_from_memory(&preview.png).unwrap().to_rgb8();
        assert!(pixels.pixels().all(|pixel| (120..=135).contains(&pixel[0])));
        assert!(previews.get(&path, size, 1, || true).unwrap().1);
        assert!(!previews.get(&path, size, 2, || true).unwrap().1);
        previews.clear();
        assert!(previews.get(&path, size, 3, || false).is_err());
        let cover = render(
            &path,
            Size {
                width: 300,
                height: 300,
                cover: true,
            },
        )
        .unwrap();
        assert_eq!((cover.width, cover.height), (300, 300));
        // File replacement must invalidate a prepared image even at the same URL.
        image::RgbImage::from_pixel(20, 10, image::Rgb([255, 0, 0]))
            .save(&path)
            .unwrap();
        let (replaced, cached) = previews.get(&path, size, 2, || true).unwrap();
        assert!(!cached);
        assert_eq!((replaced.source_width, replaced.source_height), (20, 10));
        std::fs::remove_file(path).unwrap();
    }
}
