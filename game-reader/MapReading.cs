using System;
using Microsoft.Diagnostics.Runtime;

// Reads a whole map's walls in one go: hundreds of thousands of cells are far
// too many to read one by one from PowerShell.
public static class MapReading
{
    // Bit (y * width + x), lowest bit first, is set where the tile can't be
    // walked on (Cell.Flag, or no cell at all).
    public static byte[] Walls(ClrObject mapControl)
    {
        ClrArray cells = mapControl.ReadObjectField("Cells").AsArray();
        int width = cells.GetLength(0), height = cells.GetLength(1);
        ulong[] refs = cells.ReadValues<ulong>(0, width * height) ?? new ulong[0];
        ClrInstanceField flag = cells.Type.ComponentType.GetFieldByName("Flag");
        byte[] bits = new byte[(width * height + 7) / 8];
        for (int x = 0; x < width; x++)
        {
            for (int y = 0; y < height; y++)
            {
                // Cells[x, y] is stored with y changing fastest.
                ulong cell = x * height + y < refs.Length ? refs[x * height + y] : 0;
                bool wall = cell == 0 || flag.Read<bool>(cell, false);
                if (wall) bits[(y * width + x) >> 3] |= (byte)(1 << ((y * width + x) & 7));
            }
        }
        return bits;
    }
}
