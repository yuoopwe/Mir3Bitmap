using System;
using Microsoft.Diagnostics.Runtime;

// Reads a whole map's walls in one go: hundreds of thousands of cells are far
// too many to read one by one from PowerShell.
public static class MapReading
{
    // How much of the game's memory is read at once: cells lie close together,
    // so one read covers hundreds of them.
    private const int BlockBytes = 64 * 1024;
    private const int PageBytes = 4096;

    // Bit (y * width + x), lowest bit first, is set where the tile can't be
    // walked on (Cell.Flag, or no cell at all).
    public static byte[] Walls(ClrObject mapControl)
    {
        ClrArray cells = mapControl.ReadObjectField("Cells").AsArray();
        int width = cells.GetLength(0), height = cells.GetLength(1);
        ulong[] refs = cells.ReadValues<ulong>(0, width * height) ?? new ulong[0];
        ClrInstanceField flag = cells.Type.ComponentType.GetFieldByName("Flag");
        byte[] bits = new byte[(width * height + 7) / 8];
        bool[] walls = FlagsOf(refs, flag, mapControl.Type.Heap.Runtime.DataTarget.DataReader);
        for (int x = 0; x < width; x++)
        {
            for (int y = 0; y < height; y++)
            {
                // Cells[x, y] is stored with y changing fastest.
                int i = x * height + y;
                bool wall = i >= refs.Length || walls[i];
                if (wall) bits[(y * width + x) >> 3] |= (byte)(1 << ((y * width + x) & 7));
            }
        }
        return bits;
    }

    // Each cell's Flag (true for no cell), read a block of memory at a time in
    // the order the cells lie in memory rather than one read a cell.
    private static bool[] FlagsOf(ulong[] refs, ClrInstanceField flag, IDataReader memory)
    {
        bool[] flags = new bool[refs.Length];
        ulong[] at = new ulong[refs.Length];
        int[] order = new int[refs.Length];
        int count = 0;
        ulong offset = 0;
        for (int i = 0; i < refs.Length; i++)
        {
            if (refs[i] == 0)
            {
                flags[i] = true;
                continue;
            }
            if (count == 0) offset = flag.GetAddress(refs[i], false) - refs[i];
            at[count] = refs[i] + offset;
            order[count] = i;
            count++;
        }
        Array.Sort(at, order, 0, count);
        byte[] block = new byte[BlockBytes];
        ulong start = 0;
        int got = 0;
        for (int k = 0; k < count; k++)
        {
            ulong address = at[k];
            if (got == 0 || address < start || address >= start + (ulong)got)
            {
                start = address;
                got = memory.Read(address, block);
                // A read running past the end of the game's memory there fails whole on Windows: up to the end of the
                // page then.
                if (got <= 0) got = memory.Read(address, new Span<byte>(block, 0, PageBytes - (int)(address % PageBytes)));
            }
            // Memory that can't be read in a block is read the old way.
            flags[order[k]] = got > 0 ? block[address - start] != 0 : flag.Read<bool>(address - offset, false);
            if (got <= 0) got = 0;
        }
        return flags;
    }
}
