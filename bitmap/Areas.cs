using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace bitmap
{
    public class Area
    {
        public string Name { get; set; }
        public List<Destination> Dungeons { get; set; }
        public List<Destination> OpenAreas { get; set; }

    }
}
