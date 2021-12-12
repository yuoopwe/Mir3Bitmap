using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace bitmap
{
    public class Destination
    {
        public Destination(string name, PixelLocation location)
        {
            Name = name;
            Location = location;
        }

        public string Name { get; set; }
        public PixelLocation Location { get; set; }
    }
}
