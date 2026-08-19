from PIL import Image, ImageDraw
import sys

def process_images(source_path):
    # Load the high-res image
    try:
        img = Image.open(source_path).convert("RGBA")
    except Exception as e:
        print(f"Error loading image: {e}")
        return

    # Resize to exactly 1024x1024 if not already
    img = img.resize((1024, 1024), Image.Resampling.LANCZOS)
    
    # Save the 1024x1024 mascot
    mascot_path = "/Volumes/Orange/Projects/triss/.claude/worktrees/project-website/site/public/triss-mascot.png"
    img.save(mascot_path, "PNG")
    print(f"Saved: {mascot_path}")

    # Create the 256x256 circular avatar
    avatar_size = (256, 256)
    img_small = img.resize(avatar_size, Image.Resampling.LANCZOS)
    
    # Create circular mask
    mask = Image.new("L", avatar_size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0) + avatar_size, fill=255)
    
    # Apply mask
    avatar = Image.new("RGBA", avatar_size)
    avatar.paste(img_small, (0, 0), mask)
    
    # Save the 256x256 avatar
    avatar_path = "/Volumes/Orange/Projects/triss/.claude/worktrees/project-website/site/public/triss-avatar.png"
    avatar.save(avatar_path, "PNG")
    print(f"Saved: {avatar_path}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python process_mascot.py <path_to_downloaded_image>")
        sys.exit(1)
    process_images(sys.argv[1])
